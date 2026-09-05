import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeJsonValue } from "@eigen/core";
import type {
  ExecuteExternalOptions,
  ExternalSuiteReport,
} from "@eigen/external-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExternalJobManager,
  type ExternalJob,
  type ExternalJobInput,
  type ExternalJobManager,
} from "./external-jobs.js";

const directories: string[] = [];
const managers: ExternalJobManager[] = [];
const environment = {
  OPENAI_API_KEY: "offline-job-secret",
  OPENAI_MODEL: "offline-model",
};
const input: ExternalJobInput = {
  suite_id: "reviewed-refunds-v1",
  trials: 1,
  submission_id: "submission_1",
};
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function workspace() {
  const cwd = await mkdtemp(resolve(tmpdir(), "eigen-jobs-"));
  directories.push(cwd);
  const app = resolve(cwd, "examples/refund-agent");
  await mkdir(resolve(app, "dist"), { recursive: true });
  await writeFile(
    resolve(app, "eigen.json"),
    JSON.stringify({
      version: 1,
      id: "job-test-app",
      entrypoint: "dist/index.js",
      sourceFiles: ["source.ts"],
    }),
  );
  await writeFile(
    resolve(app, "source.ts"),
    "// Only inspected; test execution is injected.\n",
  );
  await writeFile(
    resolve(app, "dist/index.js"),
    "// This file must never execute in job-manager tests.\n",
  );
  await cp(
    resolve(process.cwd(), "scenarios/external-refunds"),
    resolve(cwd, "scenarios/external-refunds"),
    { recursive: true },
  );
  return cwd;
}
function completedSuite(
  decision: "allow" | "block" = "block",
): ExternalSuiteReport {
  // The job manager consumes only these fields; executor/report validity is
  // covered by the independent external-executable integration tests.
  return {
    suite_id: "external_result",
    decision,
    runs: Array.from({ length: 6 }, () => ({})),
  } as ExternalSuiteReport;
}
function deferred<T>() {
  let resolveValue!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolve, fail) => {
    resolveValue = resolve;
    reject = fail;
  });
  return { promise, resolve: resolveValue, reject };
}

describe("external evaluation jobs", () => {
  it("runs the configured outside application with a captured model, path and timeout", async () => {
    const cwd = await workspace();
    const app = await mkdtemp(resolve(tmpdir(), "eigen-outside-job-app-"));
    directories.push(app);
    await cp(resolve(cwd, "examples/refund-agent"), app, { recursive: true });
    await writeFile(
      resolve(app, "eigen.json"),
      JSON.stringify({
        version: 1,
        id: "separate-sample",
        entrypoint: "dist/index.js",
        sourceFiles: ["source.ts"],
      }),
    );
    const project = {
      version: 1,
      application: { directory: app, entrypoint: "dist/index.js" },
      suite: { id: input.suite_id, directory: "scenarios/external-refunds" },
      model: { name: "project-model" },
      execution: { trials: 1, timeoutMs: 17000 },
    };
    await writeFile(
      resolve(cwd, "eigen.project.json"),
      JSON.stringify(project),
    );
    const execute = vi.fn(async () => completedSuite());
    const manager = createExternalJobManager({ cwd, environment, execute });
    managers.push(manager);
    const config = await manager.getConfig();
    expect(config.application.id).toBe("separate-sample");
    expect(config.model).toBe("project-model");
    expect(JSON.stringify(config)).not.toContain(app);
    const job = await manager.start(input);
    await vi.waitFor(() =>
      expect(manager.get(job.id)?.status).toBe("completed"),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        appDirectory: await realpath(app),
        timeoutMs: 17000,
        expectedApplicationHash: config.application.contentHash,
      }),
      expect.objectContaining({
        environment: {
          OPENAI_API_KEY: environment.OPENAI_API_KEY,
          OPENAI_MODEL: "project-model",
        },
      }),
    );
  });

  it("does not fall back to the reference when a project exists but is invalid", async () => {
    const cwd = await workspace();
    await writeFile(resolve(cwd, "eigen.project.json"), "{invalid");
    const execute = vi.fn(async () => completedSuite());
    const manager = createExternalJobManager({ cwd, environment, execute });
    managers.push(manager);
    expect((await manager.getConfig()).available).toBe(false);
    await expect(manager.start(input)).rejects.toMatchObject({
      code: "EVALUATION_UNAVAILABLE",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["success", "failure"] as const)(
    "makes duplicate submissions await the same durable queue %s",
    async (outcome) => {
      const cwd = await workspace();
      const saving = deferred<void>();
      const beganSaving = deferred<void>();
      const execute = vi.fn(async () => completedSuite());
      let firstWrite = true;
      const manager = createExternalJobManager({
        cwd,
        environment,
        nextId: () => "job_reservation",
        execute,
        writeJob: async (job, path) => {
          if (firstWrite) {
            firstWrite = false;
            beganSaving.resolve();
            await saving.promise;
          }
          await writeJsonValue(job, path);
        },
      });
      managers.push(manager);
      const first = manager.start(input);
      await beganSaving.promise;
      const duplicate = manager.start(input);
      const settled = Promise.allSettled([first, duplicate]);
      let duplicateSettled = false;
      void duplicate.then(
        () => {
          duplicateSettled = true;
        },
        () => {
          duplicateSettled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(duplicateSettled).toBe(false);
      expect(manager.list()).toEqual([]);
      expect(manager.get("job_reservation")).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      if (outcome === "failure") saving.reject(new Error("disk full"));
      else saving.resolve();
      const results = await settled;
      if (outcome === "failure") {
        expect(results).toMatchObject([
          {
            status: "rejected",
            reason: { status: 503, code: "JOB_PERSISTENCE_FAILED" },
          },
          {
            status: "rejected",
            reason: { status: 503, code: "JOB_PERSISTENCE_FAILED" },
          },
        ]);
        expect(manager.list()).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(results).toMatchObject([
          {
            status: "fulfilled",
            value: { id: "job_reservation", status: "queued" },
          },
          {
            status: "fulfilled",
            value: { id: "job_reservation", status: "queued" },
          },
        ]);
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
        expect(
          JSON.parse(
            await readFile(
              resolve(cwd, "reports/external-jobs/job_reservation.json"),
              "utf8",
            ),
          ),
        ).toMatchObject({ id: "job_reservation" });
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "publishes completed status only after terminal persistence %s",
    async (outcome) => {
      const cwd = await workspace();
      const saving = deferred<void>();
      const beganSaving = deferred<void>();
      const manager = createExternalJobManager({
        cwd,
        environment,
        execute: async () => completedSuite(),
        writeJob: async (job, path) => {
          if ((job as ExternalJob).status === "completed") {
            beganSaving.resolve();
            await saving.promise;
          }
          await writeJsonValue(job, path);
        },
      });
      managers.push(manager);
      const job = await manager.start(input);
      await beganSaving.promise;
      expect(manager.get(job.id)?.status).toBe("running");
      expect(manager.get(job.id)?.result_suite_id).toBeUndefined();
      expect(manager.list().some((entry) => entry.status === "completed")).toBe(
        false,
      );
      expect((await manager.start(input)).status).toBe("running");
      if (outcome === "failure")
        saving.reject(new Error("terminal disk error"));
      else saving.resolve();
      await vi.waitFor(() =>
        expect(manager.get(job.id)?.status).toBe(
          outcome === "failure" ? "failed" : "completed",
        ),
      );
      await manager.shutdown();
      const saved = JSON.parse(
        await readFile(
          resolve(cwd, `reports/external-jobs/${job.id}.json`),
          "utf8",
        ),
      );
      expect(saved.status).toBe(outcome === "failure" ? "failed" : "completed");
      if (outcome === "failure") {
        expect(saved.result_suite_id).toBeUndefined();
        expect(saved.decision).toBeUndefined();
        expect(saved.error.message).toBe("terminal disk error");
      }
    },
  );

  it("queues immediately, deduplicates concurrent submissions, reports progress, and completes a blocking evaluation", async () => {
    const cwd = await workspace();
    const completion = deferred<ExternalSuiteReport>();
    let executionOptions: ExecuteExternalOptions | undefined;
    const execute = vi.fn(async (options: ExecuteExternalOptions) => {
      executionOptions = options;
      return completion.promise;
    });
    const manager = createExternalJobManager({
      cwd,
      environment,
      nextId: () => "job_one",
      now: () => 1_800_000_000_000,
      execute,
    });
    managers.push(manager);
    const [first, duplicate] = await Promise.all([
      manager.start(input),
      manager.start(input),
    ]);
    expect(first.id).toBe(duplicate.id);
    expect(first.status).toBe("queued");
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(manager.get(first.id)?.status).toBe("running");
    await expect(
      manager.start({ ...input, submission_id: "other" }),
    ).rejects.toMatchObject({ status: 409, code: "EVALUATION_ACTIVE" });
    await expect(manager.start({ ...input, trials: 2 })).rejects.toMatchObject({
      status: 409,
      code: "SUBMISSION_CONFLICT",
    });
    await executionOptions?.onProgress?.({
      completed: 2,
      total: 6,
      scenario_id: "normal",
      trial: 1,
    });
    expect(manager.get(first.id)?.progress).toEqual({
      completed: 2,
      total: 6,
      scenario_id: "normal",
      trial: 1,
    });
    completion.resolve(completedSuite());
    await vi.waitFor(() =>
      expect(manager.get(first.id)?.status).toBe("completed"),
    );
    await manager.shutdown();
    expect(manager.get(first.id)).toMatchObject({
      decision: "block",
      result_suite_id: "external_result",
      progress: { completed: 6, total: 6 },
    });
    expect(await manager.start(input)).toMatchObject({
      id: first.id,
      status: "completed",
    });
    const saved = JSON.parse(
      await readFile(
        resolve(cwd, "reports/external-jobs/job_one.json"),
        "utf8",
      ),
    );
    expect(saved.status).toBe("completed");
    expect(JSON.stringify(saved)).not.toContain(environment.OPENAI_API_KEY);
    const config = await manager.getConfig();
    expect(config.model).toBe("offline-model");
    expect(config.application.id).toBe("job-test-app");
    expect(config.suites[0]?.scenarios).toHaveLength(6);
    expect(JSON.stringify(config)).not.toContain(environment.OPENAI_API_KEY);
  });

  it("records orchestration errors as failed and redacts supplied credentials", async () => {
    const cwd = await workspace();
    const manager = createExternalJobManager({
      cwd,
      environment,
      nextId: () => "job_failure",
      execute: async () => {
        throw new Error(`Cannot execute ${environment.OPENAI_API_KEY}`);
      },
    });
    managers.push(manager);
    const job = await manager.start(input);
    await vi.waitFor(() => expect(manager.get(job.id)?.status).toBe("failed"));
    expect(manager.get(job.id)?.error).toEqual({
      code: "EVALUATION_FAILED",
      message: "Cannot execute [REDACTED]",
    });
    expect(manager.get(job.id)?.decision).toBeUndefined();
    expect(manager.get(job.id)?.result_suite_id).toBeUndefined();
  });

  it("exposes interrupted persisted jobs after restart and never executes them", async () => {
    const cwd = await workspace();
    const timestamp = "2026-09-05T00:00:00.000Z";
    for (const status of ["queued", "running"] as const)
      await writeJsonValue(
        {
          id: `job_${status}`,
          ...input,
          submission_id: status,
          status,
          progress: { completed: 2, total: 6 },
          created_at: timestamp,
          updated_at: timestamp,
        },
        resolve(cwd, `reports/external-jobs/job_${status}.json`),
      );
    const execute = vi.fn(async () => completedSuite());
    const manager = createExternalJobManager({ cwd, environment, execute });
    managers.push(manager);
    await manager.ready;
    expect(manager.list()).toHaveLength(2);
    for (const job of manager.list()) {
      expect(job.status).toBe("failed");
      expect(job.error?.code).toBe("EVALUATION_INTERRUPTED");
      expect(job.progress.completed).toBe(2);
      expect(job.result_suite_id).toBeUndefined();
    }
    expect(execute).not.toHaveBeenCalled();
    expect(
      await manager.start({ ...input, submission_id: "running" }),
    ).toMatchObject({ id: "job_running", status: "failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("aborts active execution during shutdown and does not claim completion", async () => {
    const cwd = await workspace();
    const execute = vi.fn(
      async (options: ExecuteExternalOptions) =>
        new Promise<ExternalSuiteReport>((_resolve, reject) =>
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("stopped")),
            { once: true },
          ),
        ),
    );
    const manager = createExternalJobManager({ cwd, environment, execute });
    managers.push(manager);
    const job = await manager.start(input);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await manager.shutdown();
    expect(manager.get(job.id)).toMatchObject({
      status: "failed",
      error: { code: "EVALUATION_INTERRUPTED" },
    });
    expect(manager.get(job.id)?.result_suite_id).toBeUndefined();
  });

  it("cannot launch after shutdown while the queued record is still being saved", async () => {
    const cwd = await workspace();
    const saving = deferred<void>();
    const beganSaving = deferred<void>();
    const execute = vi.fn(async () => completedSuite());
    let firstWrite = true;
    const manager = createExternalJobManager({
      cwd,
      environment,
      execute,
      writeJob: async (job, path) => {
        if (firstWrite) {
          firstWrite = false;
          beganSaving.resolve();
          await saving.promise;
        }
        await writeJsonValue(job, path);
      },
    });
    managers.push(manager);
    const starting = manager.start(input);
    await beganSaving.promise;
    const stopped = manager.shutdown();
    saving.resolve();
    const job = await starting;
    await stopped;
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("EVALUATION_INTERRUPTED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires safe fixed inputs and durable queue metadata before executing", async () => {
    const cwd = await workspace();
    const execute = vi.fn(async () => completedSuite());
    const manager = createExternalJobManager({
      cwd,
      environment,
      execute,
      writeJob: async () => {
        throw new Error("disk full");
      },
    });
    managers.push(manager);
    await expect(manager.start({ ...input, trials: 4 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      manager.start({
        ...input,
        appDirectory: "/arbitrary",
      } as ExternalJobInput),
    ).rejects.toMatchObject({ status: 400 });
    await expect(manager.start(input)).rejects.toMatchObject({
      status: 503,
      code: "JOB_PERSISTENCE_FAILED",
    });
    expect(manager.list()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const unconfigured = createExternalJobManager({
      cwd,
      environment: {},
      execute,
    });
    managers.push(unconfigured);
    expect((await unconfigured.getConfig()).available).toBe(false);
    await expect(unconfigured.start(input)).rejects.toMatchObject({
      status: 503,
      code: "EVALUATION_UNAVAILABLE",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
