import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeJsonValue } from "@eigen/core";
import {
  type ExternalExecutionDependencies,
  type ExternalProgress,
  executeExternalSuite,
  loadExternalApplication,
  loadScenarios,
  readProject,
  resolveProject,
  scenarioSetHash,
} from "@eigen/external-runner";
import { z } from "zod";

const SUITE_ID = "reviewed-refunds-v1";
const APP_DIRECTORY = "examples/refund-agent";
const SCENARIO_DIRECTORY = "scenarios/external-refunds";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const startSchema = z
  .object({
    suite_id: z.literal(SUITE_ID),
    trials: z.number().int().min(1).max(3),
    submission_id: identifier,
  })
  .strict();
const jobSchema = z.object({
  id: identifier,
  submission_id: identifier,
  suite_id: z.literal(SUITE_ID),
  trials: z.number().int().min(1).max(3),
  status: z.enum(["queued", "running", "completed", "failed"]),
  progress: z.object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    scenario_id: z.string().optional(),
    trial: z.number().int().positive().optional(),
  }),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  result_suite_id: identifier.optional(),
  decision: z.enum(["allow", "block"]).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type ExternalJob = z.infer<typeof jobSchema>;
export type ExternalJobInput = z.infer<typeof startSchema>;
export interface ExternalJobConfig {
  default_trials?: number;
  timeout_ms?: number;
  application: { id: string; contentHash: string };
  model: string | null;
  environment: "simulation";
  suites: Array<{
    id: string;
    name: string;
    scenarios: Array<{ id: string; name: string }>;
  }>;
  available: boolean;
  unavailable_reason?: string;
}
export class ExternalJobError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface ExternalJobManager {
  ready: Promise<void>;
  getConfig(): Promise<ExternalJobConfig>;
  list(): ExternalJob[];
  get(id: string): ExternalJob | undefined;
  start(input: ExternalJobInput): Promise<ExternalJob>;
  shutdown(): Promise<void>;
}
export interface ExternalJobManagerOptions {
  cwd: string;
  environment: ExternalExecutionDependencies["environment"];
  now?(): number;
  nextId?(): string;
  execute?: typeof executeExternalSuite;
  writeJob?: typeof writeJsonValue;
  // Server dependency injection for offline tests only, never request input.
  modelBaseUrl?: string;
}

export function createExternalJobManager(
  options: ExternalJobManagerOptions,
): ExternalJobManager {
  const directory = resolve(options.cwd, "reports", "external-jobs");
  const jobs = new Map<string, ExternalJob>();
  const reservations = new Map<
    string,
    { job: ExternalJob; promise: Promise<ExternalJob> }
  >();
  const now = () => new Date(options.now?.() ?? Date.now()).toISOString();
  const execute = options.execute ?? executeExternalSuite;
  let activeId: string | undefined;
  let controller: AbortController | undefined;
  let activeTask: Promise<void> | undefined;
  let closed = false;
  // Serial writes prevent collisions on writeJsonValue's temporary filename.
  let writes = Promise.resolve();
  const persist = (job: ExternalJob) => {
    const snapshot = structuredClone(job);
    const next = writes.then(() =>
      (options.writeJob ?? writeJsonValue)(
        snapshot,
        resolve(directory, `${job.id}.json`),
      ),
    );
    writes = next.catch(() => {});
    return next;
  };
  const ready = (async () => {
    await mkdir(directory, { recursive: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const fileId = entry.name.slice(0, -5);
      if (!identifier.safeParse(fileId).success) continue;
      let job: ExternalJob;
      try {
        job = jobSchema.parse(
          JSON.parse(await readFile(resolve(directory, entry.name), "utf8")),
        );
        if (job.id !== fileId) throw new Error("Job ID mismatch");
      } catch {
        // Preserve corrupt evidence; expose it without interpreting it as paid work.
        job = {
          id: fileId,
          submission_id: fileId,
          suite_id: SUITE_ID,
          trials: 1,
          status: "failed",
          progress: { completed: 0, total: 6 },
          created_at: now(),
          updated_at: now(),
          error: {
            code: "JOB_RECORD_UNAVAILABLE",
            message:
              "The saved job record is invalid. No evaluation was resumed.",
          },
        };
        jobs.set(job.id, job);
        continue;
      }
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.updated_at = now();
        job.error = {
          code: "EVALUATION_INTERRUPTED",
          message:
            "The dashboard stopped before this evaluation finished. No evaluation was resumed.",
        };
        await persist(job);
      }
      jobs.set(job.id, job);
    }
  })();
  const resolveSelection = async () => {
    const project = await readProject(options.cwd);
    if (project) return resolveProject(options.cwd, project);
    // Keep the original reference usable until the developer creates a project.
    const application = await loadExternalApplication(
      resolve(options.cwd, APP_DIRECTORY),
    );
    const scenarioDirectory = resolve(options.cwd, SCENARIO_DIRECTORY);
    const scenarios = await loadScenarios(scenarioDirectory);
    return {
      application,
      scenarios,
      scenarioDirectory,
      project: {
        model: { name: options.environment.OPENAI_MODEL?.trim() || "" },
        execution: { trials: 1, timeoutMs: 120_000 },
      },
    };
  };
  type Selection = Awaited<ReturnType<typeof resolveSelection>>;
  const inspect = async (): Promise<{
    config: ExternalJobConfig;
    selection?: Selection;
  }> => {
    const config: ExternalJobConfig = {
      application: { id: "Not configured", contentHash: "" },
      model: null,
      environment: "simulation",
      suites: [],
      available: false,
    };
    try {
      const selection = await resolveSelection();
      config.application = {
        id: selection.application.id,
        contentHash: selection.application.contentHash,
      };
      config.model = selection.project.model.name || null;
      config.default_trials = selection.project.execution.trials;
      config.timeout_ms = selection.project.execution.timeoutMs;
      config.suites = [
        {
          id: SUITE_ID,
          name: "Reviewed refund scenarios",
          scenarios: selection.scenarios.map(({ id, name }) => ({ id, name })),
        },
      ];
      if (selection.scenarios.length !== 6)
        config.unavailable_reason =
          "The reviewed suite must contain all six scenarios.";
      else if (!options.environment.OPENAI_API_KEY?.trim() || !config.model)
        config.unavailable_reason =
          "Configure OPENAI_API_KEY and a model name on the server before running an evaluation.";
      else if (closed)
        config.unavailable_reason = "The dashboard is shutting down.";
      else config.available = true;
      return { config, selection };
    } catch {
      config.unavailable_reason =
        "Application setup is incomplete. Run eigen doctor in the local project to check its configuration, build, and reviewed suite.";
      return { config };
    }
  };
  const getConfig = async () => (await inspect()).config;
  const findSubmission = (
    input: ExternalJobInput,
  ): ExternalJob | Promise<ExternalJob> | undefined => {
    const reservation = reservations.get(input.submission_id);
    const existing =
      reservation?.job ??
      [...jobs.values()].find(
        (job) => job.submission_id === input.submission_id,
      );
    if (
      existing &&
      (existing.suite_id !== input.suite_id || existing.trials !== input.trials)
    )
      throw new ExternalJobError(
        409,
        "SUBMISSION_CONFLICT",
        "This submission was already used with different settings.",
      );
    return reservation?.promise ?? existing;
  };
  const run = async (
    job: ExternalJob,
    signal: AbortSignal,
    selection: Selection,
  ) => {
    try {
      signal.throwIfAborted();
      job.status = "running";
      job.updated_at = now();
      await persist(job);
      const report = await execute(
        {
          cwd: options.cwd,
          appDirectory: selection.application.directory,
          expectedApplicationHash: selection.application.contentHash,
          expectedScenarioHash: scenarioSetHash(selection.scenarios),
          scenarioDirectory: selection.scenarioDirectory,
          reviewedSuiteId: SUITE_ID,
          runs: job.trials,
          timeoutMs: selection.project.execution.timeoutMs,
          signal,
          async onProgress(progress: ExternalProgress) {
            job.progress = { ...progress };
            job.updated_at = now();
            await persist(job);
          },
        },
        {
          environment: {
            OPENAI_API_KEY: options.environment.OPENAI_API_KEY,
            OPENAI_MODEL: selection.project.model.name,
          },
          nextId: () => `external_${job.id}`,
          now,
          ...(options.modelBaseUrl
            ? { modelBaseUrl: options.modelBaseUrl }
            : {}),
        },
      );
      signal.throwIfAborted();
      const completed: ExternalJob = {
        ...job,
        status: "completed",
        result_suite_id: report.suite_id,
        decision: report.decision,
        progress: { completed: report.runs.length, total: report.runs.length },
        updated_at: now(),
      };
      await persist(completed);
      jobs.set(job.id, completed);
    } catch (error) {
      job.status = "failed";
      delete job.result_suite_id;
      delete job.decision;
      job.updated_at = now();
      const secret = options.environment.OPENAI_API_KEY;
      const message =
        error instanceof Error
          ? error.message
          : "The evaluation could not finish.";
      job.error = signal.aborted
        ? {
            code: "EVALUATION_INTERRUPTED",
            message:
              "The dashboard stopped before this evaluation finished. No evaluation will resume automatically.",
          }
        : {
            code: "EVALUATION_FAILED",
            message: secret
              ? message.split(secret).join("[REDACTED]")
              : message,
          };
      await persist(job).catch(() => {});
    } finally {
      activeId = undefined;
      controller = undefined;
    }
  };
  return {
    ready,
    getConfig,
    list: () =>
      structuredClone(
        [...jobs.values()].sort((a, b) =>
          b.created_at.localeCompare(a.created_at),
        ),
      ),
    get: (id) => {
      const job = jobs.get(id);
      return job ? structuredClone(job) : undefined;
    },
    async start(rawInput) {
      await ready;
      const parsed = startSchema.safeParse(rawInput);
      if (!parsed.success)
        throw new ExternalJobError(
          400,
          "INVALID_EVALUATION_INPUT",
          "Choose the reviewed suite and 1–3 trials with a valid submission ID.",
        );
      const input = parsed.data;
      const prior = findSubmission(input);
      if (prior) return structuredClone(await prior);
      if (closed)
        throw new ExternalJobError(
          503,
          "DASHBOARD_STOPPING",
          "The dashboard is shutting down.",
        );
      if (activeId)
        throw new ExternalJobError(
          409,
          "EVALUATION_ACTIVE",
          "An external evaluation is already active.",
        );
      const { config, selection } = await inspect();
      if (!config.available || !selection)
        throw new ExternalJobError(
          503,
          "EVALUATION_UNAVAILABLE",
          config.unavailable_reason ?? "Evaluation is unavailable.",
        );
      // Recheck after asynchronous validation before taking the active slot.
      const duplicate = findSubmission(input);
      if (duplicate) return structuredClone(await duplicate);
      if (closed || activeId)
        throw new ExternalJobError(
          409,
          "EVALUATION_ACTIVE",
          "An external evaluation is already active or the dashboard is stopping.",
        );
      const id = options.nextId?.() ?? `job_${randomUUID()}`;
      if (!identifier.safeParse(id).success || jobs.has(id))
        throw new ExternalJobError(
          409,
          "JOB_ID_CONFLICT",
          "A new unique job ID could not be reserved.",
        );
      const scenarioCount = config.suites.find(
        (suite) => suite.id === input.suite_id,
      )?.scenarios.length;
      if (!scenarioCount)
        throw new ExternalJobError(
          503,
          "EVALUATION_UNAVAILABLE",
          "The reviewed scenarios are unavailable.",
        );
      const job: ExternalJob = {
        id,
        ...input,
        status: "queued",
        progress: { completed: 0, total: scenarioCount * input.trials },
        created_at: now(),
        updated_at: now(),
      };
      activeId = id;
      const reservation = (async () => {
        try {
          await persist(job);
        } catch {
          activeId = undefined;
          throw new ExternalJobError(
            503,
            "JOB_PERSISTENCE_FAILED",
            "The evaluation could not be queued because its job record could not be saved.",
          );
        }
        jobs.set(id, job);
        if (closed) {
          job.status = "failed";
          job.updated_at = now();
          job.error = {
            code: "EVALUATION_INTERRUPTED",
            message:
              "The dashboard stopped while this evaluation was being queued. No evaluation was started.",
          };
          activeId = undefined;
          await persist(job);
          return structuredClone(job);
        }
        const queued = structuredClone(job);
        controller = new AbortController();
        activeTask = run(job, controller.signal, selection);
        return queued;
      })().finally(() => reservations.delete(input.submission_id));
      reservations.set(input.submission_id, { job, promise: reservation });
      return reservation;
    },
    async shutdown() {
      closed = true;
      await ready;
      await Promise.allSettled(
        [...reservations.values()].map(({ promise }) => promise),
      );
      controller?.abort();
      await activeTask;
      await writes;
    },
  };
}
