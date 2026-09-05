import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type ExternalSuiteReport,
  FINANCIAL_EVALUATOR_VERSION,
  loadScenarios,
  reviewedSuiteDirectory,
  scenarioProvenance,
} from "@eigen/external-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformApi } from "./api.js";
import type { GitHubProvider } from "./github.js";
import { decrypt, digest, encrypt, safeRepoPath } from "./security.js";
import { createPlatformService } from "./service.js";
import { createMemoryStore } from "./store.js";
import { createPlatformWorker } from "./worker.js";

const owner = { id: "user-one", name: "Developer", email: "dev@example.test" };
const stranger = { ...owner, id: "user-two" };
const key = Buffer.alloc(32, 7).toString("base64");
const repo = {
  id: 42,
  installationId: 7,
  owner: "developer",
  name: "refund",
  defaultBranch: "main",
  private: true,
};
const commit = "a".repeat(40);
const candidateCommit = "b".repeat(40);
const templates = await loadScenarios(reviewedSuiteDirectory);
const fixture = JSON.parse(
  await readFile(
    new URL("../../fixtures/external-suite.json", import.meta.url),
    "utf8",
  ),
) as ExternalSuiteReport;
let ids = 0;
let clock = new Date("2026-09-05T12:00:00Z");
const store = () => createMemoryStore();
function context() {
  const database = store();
  const github: GitHubProvider = {
    authorizeUrl: vi.fn(
      (state: string) =>
        `https://github.com/login/oauth/authorize?state=${state}`,
    ),
    installationUrl: () => "https://github.com/apps/eigen/installations/new",
    exchange: vi.fn(async () => ({ access_token: "test-github-token" })),
    refresh: vi.fn(async () => ({ access_token: "refreshed" })),
    user: vi.fn(async () => ({ id: 12, login: "developer" })),
    repositories: vi.fn(async () => [repo]),
    branches: vi.fn(async () => ["main", "develop"]),
    resolve: vi.fn(async () => commit),
    snapshot: vi.fn(async () => ({
      commit,
      files: { "package.json": "{}", "agent.js": "original application" },
    })),
    publish: vi.fn(async () => ({
      number: 1,
      url: "https://github.com/developer/refund/pull/1",
      commit: candidateCommit,
    })),
    check: vi.fn(async () => {}),
  };
  const setup = {
    ready: true,
    missing: [],
    githubReady: true,
    workerReady: true,
  };
  const service = createPlatformService({
    store: database,
    github,
    tokenKey: key,
    webhookSecret: "webhook-test",
    origin: "https://eigen.example.test",
    model: "test-model",
    templates,
    setup,
    nextId: () => `id-${++ids}`,
    now: () => clock,
  });
  return {
    database,
    github,
    service,
    api: createPlatformApi(service, setup, "https://eigen.example.test"),
  };
}
async function connected() {
  const ctx = context();
  const value = await ctx.service.connect(owner);
  await ctx.service.callback("code", value.state, digest(value.state));
  const project = await ctx.service.createProject(owner, repo.id, "main");
  return { ...ctx, project };
}
beforeEach(() => {
  ids = 0;
  clock = new Date("2026-09-05T12:00:00Z");
});

describe("project authorization and immutable tests", () => {
  it("binds a single-use OAuth callback to its initiating browser and keeps tokens encrypted", async () => {
    const ctx = context();
    const value = await ctx.service.connect(owner);
    await expect(
      ctx.service.callback("code", value.state, "wrong-cookie"),
    ).rejects.toThrow("another browser");
    await ctx.service.callback("code", value.state, digest(value.state));
    await expect(
      ctx.service.callback("code", value.state, digest(value.state)),
    ).rejects.toThrow("expired");
    expect(
      await ctx.database.read((state) => JSON.stringify(state.connections)),
    ).not.toContain("test-github-token");
    expect(await ctx.service.token(owner.id)).toBe("test-github-token");
  });
  it("rejects expired OAuth state without exchanging the code", async () => {
    const ctx = context();
    const value = await ctx.service.connect(owner);
    clock = new Date("2026-09-05T13:00:00Z");
    await expect(
      ctx.service.callback("code", value.state, digest(value.state)),
    ).rejects.toThrow("expired");
    expect(ctx.github.exchange).not.toHaveBeenCalled();
  });
  it("checks repository access and creates one owned project with its integration job", async () => {
    const { service, database, project } = await connected();
    expect((await service.createProject(owner, repo.id, "main")).id).toBe(
      project.id,
    );
    expect(await service.projects(stranger)).toEqual([]);
    await expect(service.project(stranger, project.id)).rejects.toThrow(
      "not found",
    );
    await expect(service.createProject(owner, 999, "main")).rejects.toThrow(
      "not found",
    );
    expect(
      await database.read((state) => Object.keys(state.jobs)),
    ).toHaveLength(1);
  });
  it("version-controls custom tests without changing reviewed or historical inputs", async () => {
    const { service, project } = await connected();
    const original = await service.project(owner, project.id);
    const first = original.tests[0];
    if (!first) throw new Error("Missing template");
    await expect(
      service.saveTest(owner, project.id, first.scenario, first.testId),
    ).rejects.toThrow("immutable");
    const copy = await service.saveTest(owner, project.id, {
      ...first.scenario,
      name: "Custom timeout",
    });
    const revised = await service.saveTest(
      owner,
      project.id,
      { ...copy.scenario, name: "Revised timeout" },
      copy.testId,
    );
    const after = await service.project(owner, project.id);
    expect(revised.version).toBe(2);
    expect(revised.scenario.id).toBe(copy.scenario.id);
    expect(after.tests.find((test) => test.id === copy.id)?.scenario.name).toBe(
      "Custom timeout",
    );
    expect(after.tests.filter((test) => test.source === "reviewed")).toEqual(
      original.tests,
    );
    await expect(
      service.saveTest(stranger, project.id, copy.scenario),
    ).rejects.toThrow("not found");
  });
  it("freezes commit, model, and test versions and rejects cross-project test selection", async () => {
    const { service, project } = await connected();
    const before = await service.project(owner, project.id);
    const job = await service.run(owner, project.id, { kind: "evaluation" });
    expect(job?.commit).toBe(commit);
    expect(job?.testVersionIds).toEqual(before.suites[0]?.testVersionIds);
    await expect(
      service.run(owner, project.id, {
        kind: "evaluation",
        testVersionIds: ["foreign-test"],
      }),
    ).rejects.toThrow("this project");
    expect(
      (await service.run(owner, project.id, { kind: "evaluation" }))?.id,
    ).toBe(job?.id);
  });
  it("does not let the API accept shell commands or an unauthenticated project request", async () => {
    const { api, project } = await connected();
    expect(
      (await api(new Request("https://eigen.example.test/api/projects")))
        ?.status,
    ).toBe(401);
    const response = await api(
      new Request(
        `https://eigen.example.test/api/projects/${project.id}/jobs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "evaluation", command: "rm -rf /" }),
        },
      ),
      owner,
    );
    expect(response?.status).toBe(400);
    expect(
      (
        await api(
          new Request(`https://eigen.example.test/api/projects/${project.id}`),
          stranger,
        )
      )?.status,
    ).toBe(404);
  });
  it("disconnects immediately and blocks subsequent jobs", async () => {
    const { service, project } = await connected();
    await service.updateProject(owner, project.id, { disconnect: true });
    await expect(
      service.run(owner, project.id, { kind: "evaluation" }),
    ).rejects.toThrow("Reconnect");
    expect((await service.project(owner, project.id)).jobs[0]?.status).toBe(
      "cancelled",
    );
  });
});

describe("GitHub events and durable worker", () => {
  it("verifies webhook signatures, deduplicates deliveries, and ignores fork PR execution", async () => {
    const { service, project, database } = await connected();
    await database.transaction((state) => {
      const saved = state.projects[project.id];
      if (saved) saved.integration = "ready";
    });
    const body = JSON.stringify({
      installation: { id: 7 },
      repository: { id: 42 },
      ref: "refs/heads/main",
      after: candidateCommit,
    });
    const signature = `sha256=${createHmac("sha256", "webhook-test").update(body).digest("hex")}`;
    await expect(
      service.webhook(body, "invalid", "one", "push"),
    ).rejects.toThrow("signature");
    expect(await service.webhook(body, signature, "one", "push")).toEqual({
      duplicate: false,
    });
    expect(await service.webhook(body, signature, "one", "push")).toEqual({
      duplicate: true,
    });
    const fork = JSON.stringify({
      installation: { id: 7 },
      repository: { id: 42 },
      action: "opened",
      pull_request: { head: { sha: "c".repeat(40), repo: { id: 99 } } },
    });
    await service.webhook(
      fork,
      `sha256=${createHmac("sha256", "webhook-test").update(fork).digest("hex")}`,
      "two",
      "pull_request",
    );
    expect(
      await database.read((state) =>
        Object.values(state.jobs).filter((job) => job.automatic),
      ),
    ).toHaveLength(1);
  });
  it("publishes the actual candidate with evidence and keeps financial failure distinct from integration", async () => {
    const { service, project, github, database } = await connected();
    const source = await github.snapshot(repo, commit);
    const changed = { "eigen.json": "integration" };
    const report = structuredClone(fixture);
    report.provenance = {
      version: 1,
      evaluator_version: FINANCIAL_EVALUATOR_VERSION,
      scenarios: templates.map(scenarioProvenance),
      trials_per_scenario: 1,
      timeout_ms: 120000,
      model_configuration: {
        provider: "openai",
        model: "test-model",
        execution: "openai",
        verified: true,
      },
      trial_matrix: templates.map((scenario) => ({
        scenario_id: scenario.id,
        run_number: 1,
        task_expectation: scenario.task_expectation ?? "complete",
      })),
    };
    const trial = fixture.runs[0];
    if (!trial) throw new Error("Missing fixture trial");
    report.runs = templates.map((scenario) => ({
      ...structuredClone(trial),
      scenario_id: scenario.id,
      report: {
        ...structuredClone(trial.report),
        final_claim_source: "agent",
      },
    }));
    const coding = {
      run: vi.fn(async () => ({
        files: changed,
        summary: "Added the evaluation entrypoint",
        needsConfiguration: false,
        report,
        verifiedFiles: { ...source.files, ...changed },
      })),
    };
    const worker = createPlatformWorker({
      service,
      coding,
      evaluator: { evaluate: vi.fn(async () => report) },
      nextId: () => `worker-${++ids}`,
      now: () => clock,
    });
    await worker.tick();
    const detail = await service.project(owner, project.id);
    expect(github.publish).toHaveBeenCalledOnce();
    expect(detail.pullRequests[0]?.candidateCommit).toBe(candidateCommit);
    expect(detail.runs[0]?.commit).toBe(candidateCommit);
    expect(detail.project.integration).toBe("ready");
    expect(detail.pullRequests[0]?.verified).toBe(true);
    expect(detail.jobs[0]).not.toHaveProperty("candidate");
    expect(
      await database.read((state) =>
        Object.values(state.events).some(
          (event) => event.stage === "published",
        ),
      ),
    ).toBe(true);
    expect(await worker.tick()).toBe(false);
  });
  it("never marks changed-after-verification files as verified", async () => {
    const { service, project } = await connected();
    const coding = {
      run: vi.fn(async () => ({
        files: { "agent.js": "new after verification" },
        summary: "Changed source",
        needsConfiguration: false,
        report: fixture,
        verifiedFiles: { "agent.js": "older verified version" },
      })),
    };
    await createPlatformWorker({
      service,
      coding,
      evaluator: { evaluate: vi.fn(async () => fixture) },
      now: () => clock,
    }).tick();
    const detail = await service.project(owner, project.id);
    expect(detail.pullRequests[0]?.draft).toBe(true);
    expect(detail.pullRequests[0]?.verified).toBe(false);
    expect(detail.runs).toHaveLength(0);
  });
  it("records a provider failure and does not fabricate a PR", async () => {
    const { service, project, github } = await connected();
    vi.mocked(github.snapshot).mockRejectedValueOnce(
      new Error("provider failure"),
    );
    await createPlatformWorker({
      service,
      coding: { run: vi.fn() },
      evaluator: { evaluate: vi.fn() },
      now: () => clock,
    }).tick();
    const detail = await service.project(owner, project.id);
    expect(detail.jobs[0]?.status).toBe("failed");
    expect(detail.pullRequests).toEqual([]);
    expect(github.publish).not.toHaveBeenCalled();
  });
  it("fences a cancelled job before PR publication", async () => {
    const { service, project, github } = await connected();
    const coding = {
      run: vi.fn(async () => {
        const job = (await service.project(owner, project.id)).jobs[0];
        if (!job) throw new Error("Missing job");
        await service.cancel(owner, project.id, job.id);
        return {
          files: { "agent.js": "change" },
          summary: "Changed",
          needsConfiguration: false,
          report: null,
          verifiedFiles: null,
        };
      }),
    };
    await createPlatformWorker({
      service,
      coding,
      evaluator: { evaluate: vi.fn() },
      now: () => clock,
    }).tick();
    expect(github.publish).not.toHaveBeenCalled();
    expect((await service.project(owner, project.id)).jobs[0]?.status).toBe(
      "cancelled",
    );
  });
  it("marks an expired execution lease incomplete instead of silently restarting an agent", async () => {
    const { service, project, database } = await connected();
    await database.transaction((state) => {
      const job = Object.values(state.jobs)[0];
      if (!job) throw new Error("Missing job");
      job.status = "running";
      job.lease = "dead-worker";
      job.leaseUntil = "2026-09-05T11:00:00Z";
    });
    const worker = createPlatformWorker({
      service,
      coding: { run: vi.fn() },
      evaluator: { evaluate: vi.fn() },
      now: () => clock,
    });
    expect(await worker.tick()).toBe(false);
    expect((await service.project(owner, project.id)).jobs[0]?.status).toBe(
      "incomplete",
    );
  });
});

describe("frozen repairs and execution limits", () => {
  it("uses the failed run's exact tests and model even after defaults change, and rejects foreign evidence", async () => {
    const { service, project, database } = await connected();
    const detail = await service.project(owner, project.id);
    const testIds = detail.tests.map((test) => test.id);
    await database.transaction((state) => {
      state.runs["failed-source"] = {
        id: "failed-source",
        ownerId: owner.id,
        projectId: project.id,
        jobId: "prior",
        commit: candidateCommit,
        testVersionIds: testIds,
        model: "frozen-model",
        createdAt: clock.toISOString(),
        report: { ...fixture, decision: "block" },
      };
      const stored = state.projects[project.id];
      if (stored) stored.model = "new-default-model";
    });
    const repair = await service.run(owner, project.id, {
      kind: "repair",
      runId: "failed-source",
      testVersionIds: [testIds[0] ?? ""],
    });
    expect(repair?.commit).toBe(candidateCommit);
    expect(repair?.model).toBe("frozen-model");
    expect(repair?.testVersionIds).toEqual(testIds);
    await expect(
      service.run(stranger, project.id, {
        kind: "repair",
        runId: "failed-source",
      }),
    ).rejects.toThrow("not found");
    await expect(
      service.run(owner, project.id, {
        kind: "evaluation",
        runId: "failed-source",
      }),
    ).rejects.toThrow("only for a repair");
  });
  it("stops coding at the total five-minute deadline without publishing a PR", async () => {
    vi.useFakeTimers();
    try {
      const { service, project, github } = await connected();
      const coding = {
        run: vi.fn(
          ({ signal }: { signal: AbortSignal }) =>
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener(
                "abort",
                () => reject(new Error("deadline")),
                { once: true },
              ),
            ),
        ),
      };
      const worker = createPlatformWorker({
        service,
        coding,
        evaluator: { evaluate: vi.fn() },
        now: () => clock,
      });
      const running = worker.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(coding.run).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(300001);
      await running;
      expect(github.publish).not.toHaveBeenCalled();
      expect((await service.project(owner, project.id)).jobs[0]?.status).toBe(
        "incomplete",
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("rechecks revoked repository access before publication", async () => {
    const { service, project, github } = await connected();
    const coding = {
      run: vi.fn(async () => {
        vi.mocked(github.repositories).mockResolvedValue([]);
        return {
          files: { "agent.js": "candidate" },
          summary: "Change",
          needsConfiguration: false,
          report: null,
          verifiedFiles: null,
        };
      }),
    };
    await createPlatformWorker({
      service,
      coding,
      evaluator: { evaluate: vi.fn() },
      now: () => clock,
    }).tick();
    expect(github.publish).not.toHaveBeenCalled();
    expect((await service.project(owner, project.id)).jobs[0]?.status).toBe(
      "failed",
    );
  });
});

describe("credential and source boundaries", () => {
  it("authenticates encrypted tokens and rejects tampering", () => {
    const value = encrypt("secret", key);
    expect(decrypt(value, key)).toBe("secret");
    const tampered = Buffer.from(value, "base64");
    tampered[13] = (tampered[13] ?? 0) ^ 1;
    expect(() => decrypt(tampered.toString("base64"), key)).toThrow();
  });
  it.each([
    "../escape",
    "/etc/passwd",
    "src/../../escape",
    ".git/config",
    ".env",
    ".env.local",
    ".github/workflows/deploy.yml",
    "node_modules/a.js",
  ])("rejects unsafe source path %s", (path) => {
    expect(() => safeRepoPath(path)).toThrow();
  });
});
