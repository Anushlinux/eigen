import { describe, expect, it, vi } from "vitest";
import { createDashboardApi, type DashboardApiDependencies } from "./api.js";
import {
  type ExternalJob,
  ExternalJobError,
  type ExternalJobManager,
} from "./external-jobs.js";

const queued: ExternalJob = {
  id: "job_test",
  submission_id: "submission_test",
  suite_id: "reviewed-refunds-v1",
  trials: 1,
  status: "queued",
  progress: { completed: 0, total: 6 },
  created_at: "2026-09-05T00:00:00.000Z",
  updated_at: "2026-09-05T00:00:00.000Z",
};
const input = {
  suite_id: "reviewed-refunds-v1",
  trials: 1,
  submission_id: "submission_test",
};
function fixture() {
  const manager: ExternalJobManager = {
    ready: Promise.resolve(),
    getConfig: vi.fn(async () => ({
      application: { id: "reference", contentHash: "a".repeat(64) },
      model: "test-model",
      environment: "simulation",
      suites: [
        {
          id: "reviewed-refunds-v1",
          name: "Reviewed suite",
          scenarios: [{ id: "normal", name: "Normal refund" }],
        },
      ],
      available: true,
    })),
    list: vi.fn(() => [queued]),
    get: vi.fn((id) => (id === queued.id ? queued : undefined)),
    start: vi.fn(async () => queued),
    shutdown: vi.fn(async () => {}),
  };
  const dependencies: DashboardApiDependencies = {
    cwd: "/tmp/eigen-job-api-test",
    environment: {
      OPENAI_API_KEY: "never-return-this-secret",
      OPENAI_MODEL: "test-model",
    },
    now: () => 0,
    nextToken: () => "unused",
    prepare: vi.fn(),
    execute: vi.fn(),
    externalJobs: manager,
  };
  return { api: createDashboardApi(dependencies), manager, dependencies };
}
function request(
  path: string,
  body?: unknown,
  origin = "http://127.0.0.1:4173",
) {
  return new Request(
    `http://127.0.0.1:4173${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify(body),
        },
  );
}
describe("external job API", () => {
  it("returns only configured metadata and saved job status without executing", async () => {
    const { api, manager, dependencies } = fixture();
    for (const path of [
      "/api/external/config",
      "/api/external/jobs",
      "/api/external/jobs/job_test",
    ]) {
      const response = await api(request(path));
      expect(response?.status).toBe(200);
      expect(await response?.text()).not.toContain("never-return-this-secret");
    }
    expect(manager.start).not.toHaveBeenCalled();
    expect(dependencies.execute).not.toHaveBeenCalled();
    expect((await api(request("/api/external/jobs/unknown")))?.status).toBe(
      404,
    );
  });
  it("responds with accepted job identity and preserves manager conflicts", async () => {
    const { api, manager } = fixture();
    const response = await api(request("/api/external/jobs", input));
    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ job: queued });
    expect(manager.start).toHaveBeenCalledWith(input);
    vi.mocked(manager.start).mockRejectedValue(
      new ExternalJobError(
        409,
        "EVALUATION_ACTIVE",
        "An evaluation is active.",
      ),
    );
    expect(
      (
        await api(
          request("/api/external/jobs", { ...input, submission_id: "another" }),
        )
      )?.status,
    ).toBe(409);
  });
  it.each([
    { trials: 0 },
    { trials: 4 },
    { trials: 1.5 },
    { suite_id: "../../arbitrary" },
    { appDirectory: "/tmp/app" },
    { command: "node arbitrary.js" },
    { environment: { OPENAI_MODEL: "other" } },
    { report_path: "/tmp/report" },
  ])("rejects untrusted launch fields %j", async (override) => {
    const { api, manager } = fixture();
    expect(
      (await api(request("/api/external/jobs", { ...input, ...override })))
        ?.status,
    ).toBe(400);
    expect(manager.start).not.toHaveBeenCalled();
  });
  it("rejects cross-origin and non-JSON launch requests", async () => {
    const { api, manager } = fixture();
    expect(
      (await api(request("/api/external/jobs", input, "https://other.example")))
        ?.status,
    ).toBe(403);
    expect(
      (
        await api(
          new Request("http://127.0.0.1:4173/api/external/jobs", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "{}",
          }),
        )
      )?.status,
    ).toBe(415);
    expect(manager.start).not.toHaveBeenCalled();
  });
  it("does not disclose raw orchestration exceptions", async () => {
    const { api, manager } = fixture();
    vi.mocked(manager.start).mockRejectedValue(
      new Error("never-return-this-secret"),
    );
    const response = await api(request("/api/external/jobs", input));
    expect(response?.status).toBe(503);
    expect(await response?.text()).not.toContain("never-return-this-secret");
  });
});
