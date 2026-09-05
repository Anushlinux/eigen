// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { ExternalLauncher } from "./ExternalLauncher";
import type { ExternalJob, ExternalJobConfig } from "./external-job-types";

vi.mock("./api", () => ({
  fetchExternalConfig: vi.fn(),
  fetchExternalJobs: vi.fn(),
  fetchExternalJob: vi.fn(),
  startExternalJob: vi.fn(),
}));
const config: ExternalJobConfig = {
  application: { id: "refund-support-reference", contentHash: "a".repeat(64) },
  model: "offline-model",
  environment: "simulation",
  available: true,
  suites: [
    {
      id: "reviewed-refunds-v1",
      name: "Reviewed refund suite",
      scenarios: Array.from({ length: 6 }, (_, index) => ({
        id: `scenario-${index}`,
        name: `Scenario ${index + 1}`,
      })),
    },
  ],
};
function job(overrides: Partial<ExternalJob> = {}): ExternalJob {
  return {
    id: "job_test",
    submission_id: "submission_test",
    suite_id: "reviewed-refunds-v1",
    trials: 1,
    status: "queued",
    progress: { completed: 0, total: 6 },
    created_at: "2026-09-05T00:00:00.000Z",
    updated_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}
beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  vi.mocked(api.fetchExternalConfig).mockResolvedValue(config);
  vi.mocked(api.fetchExternalJobs).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("external evaluation launcher", () => {
  it("shows the connected sample and applies the project's default budget", async () => {
    vi.mocked(api.fetchExternalConfig).mockResolvedValue({
      ...config,
      application: { id: "eigen-refund-sample", contentHash: "b".repeat(64) },
      default_trials: 2,
      timeout_ms: 45000,
    });
    render(<ExternalLauncher onCompleted={vi.fn()} />);
    expect(await screen.findByText("eigen-refund-sample")).toBeTruthy();
    expect(screen.getByText("45 seconds")).toBeTruthy();
    expect(
      screen.getByText(/6 scenarios × 2 trials = 12 application runs/),
    ).toBeTruthy();
  });
  it("shows the budget and starts once on repeated clicks, then opens a completed BLOCK suite", async () => {
    let resolveStart: ((value: ExternalJob) => void) | undefined;
    vi.mocked(api.startExternalJob).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    vi.mocked(api.fetchExternalJob).mockResolvedValue(
      job({
        status: "completed",
        progress: { completed: 6, total: 6 },
        decision: "block",
        result_suite_id: "suite_new",
      }),
    );
    const onCompleted = vi.fn();
    render(<ExternalLauncher onCompleted={onCompleted} />);
    const start = await screen.findByRole("button", { name: "Run evaluation" });
    expect(
      screen.getByText(/6 scenarios × 1 trial = 6 application runs/),
    ).toBeTruthy();
    fireEvent.click(start);
    fireEvent.click(start);
    expect(api.startExternalJob).toHaveBeenCalledTimes(1);
    const input = vi.mocked(api.startExternalJob).mock.calls[0]?.[0];
    expect(input).toEqual({
      suite_id: "reviewed-refunds-v1",
      trials: 1,
      submission_id: expect.any(String),
    });
    resolveStart?.(job({ submission_id: input?.submission_id ?? "missing" }));
    expect(
      await screen.findByRole("heading", { name: "Evaluation queued" }),
    ).toBeTruthy();
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith("suite_new"), {
      timeout: 2500,
    });
    expect(
      screen.getByRole("heading", { name: "Evaluation completed" }),
    ).toBeTruthy();
    expect(screen.getByText(/saved suite contains failed trials/)).toBeTruthy();
    expect(api.startExternalJob).toHaveBeenCalledTimes(1);
  });

  it("retries an uncertain submission using its original identity and budget", async () => {
    vi.mocked(api.startExternalJob)
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockImplementationOnce(async (input) =>
        job({ submission_id: input.submission_id }),
      );
    const user = userEvent.setup();
    render(<ExternalLauncher onCompleted={vi.fn()} />);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Trials per scenario" }),
      "3",
    );
    await user.click(screen.getByRole("button", { name: "Run evaluation" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Connection lost"),
    );
    await user.click(screen.getByRole("button", { name: "Retry submission" }));
    expect(api.startExternalJob).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.startExternalJob).mock.calls[1]?.[0]).toEqual(
      vi.mocked(api.startExternalJob).mock.calls[0]?.[0],
    );
    expect(vi.mocked(api.startExternalJob).mock.calls[0]?.[0].trials).toBe(3);
  });

  it("recovers an active job after refresh and shows interruption without starting another", async () => {
    vi.mocked(api.fetchExternalJobs).mockResolvedValue([
      job({ status: "running" }),
    ]);
    vi.mocked(api.fetchExternalJob).mockResolvedValue(
      job({
        status: "failed",
        error: {
          code: "interrupted",
          message: "The server restarted. Start another evaluation explicitly.",
        },
      }),
    );
    render(<ExternalLauncher onCompleted={vi.fn()} />);
    expect(
      await screen.findByRole("heading", { name: "Evaluation running" }),
    ).toBeTruthy();
    await waitFor(
      () =>
        expect(
          screen.getByRole("heading", { name: "Evaluation could not finish" }),
        ).toBeTruthy(),
      { timeout: 2500 },
    );
    expect(screen.getByText(/server restarted/)).toBeTruthy();
    expect(api.startExternalJob).not.toHaveBeenCalled();
  });

  it("keeps polling failures separate from execution and never resubmits", async () => {
    vi.mocked(api.fetchExternalJobs).mockResolvedValue([
      job({ status: "running" }),
    ]);
    vi.mocked(api.fetchExternalJob).mockRejectedValue(
      new Error("Server unavailable"),
    );
    render(<ExternalLauncher onCompleted={vi.fn()} />);
    await waitFor(
      () =>
        expect(screen.getByRole("alert").textContent).toContain(
          "no evaluation will be resubmitted",
        ),
      { timeout: 2500 },
    );
    expect(api.startExternalJob).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Evaluation in progress" }),
    ).toHaveProperty("disabled", true);
  });

  it("disables launch when configuration is unavailable", async () => {
    vi.mocked(api.fetchExternalConfig).mockResolvedValue({
      ...config,
      available: false,
      unavailable_reason: "Build the configured local application.",
    });
    render(<ExternalLauncher onCompleted={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Build the configured local application.",
    );
    expect(
      screen.getByRole("button", { name: "Run evaluation" }),
    ).toHaveProperty("disabled", true);
    expect(api.startExternalJob).not.toHaveBeenCalled();
  });
});
