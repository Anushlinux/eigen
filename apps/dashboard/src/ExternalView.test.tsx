// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/external-suite.json";
import {
  type ExternalSuiteReport,
  externalSuiteReportSchema,
} from "../server/external-report-schema";
import { App } from "./App";
import { ExternalView } from "./ExternalView";
import type { ReportSummary } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function suite(): ExternalSuiteReport {
  return externalSuiteReportSchema.parse(structuredClone(fixture));
}
function summary(report: ExternalSuiteReport): ReportSummary {
  return {
    kind: "external",
    id: report.suite_id,
    subject: report.application.id,
    created_at: null,
    decision: report.decision,
    schema_version: report.schema_version,
    availability: "ready",
  };
}
function response(value: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(value), { status }));
}
function setup(reports: ExternalSuiteReport[]) {
  const summaries = reports.map(summary);
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/external/config")
      return response({
        config: {
          application: { id: "reference", contentHash: "" },
          model: null,
          environment: "simulation",
          suites: [],
          available: false,
          unavailable_reason: "Not configured for this read-only fixture",
        },
      });
    if (path === "/api/external/jobs") return response({ jobs: [] });
    if (path === "/api/status")
      return response({
        razorpay_test_credentials_configured: false,
        live_credentials_rejected: false,
        openai_configured: true,
        writes_enabled: false,
      });
    if (path === "/api/reports") return response({ reports: summaries });
    const selected = reports.find(
      (report) => path === `/api/reports/external/${report.suite_id}`,
    );
    if (selected) return response({ report: selected });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { summaries, fetch };
}

describe("external evaluation dashboard", () => {
  it("prefers a readable completed suite over an unfinished history entry", async () => {
    const report = suite();
    const { summaries, fetch } = setup([report]);
    render(
      <ExternalView
        summaries={[
          {
            ...summary(report),
            id: "unfinished",
            availability: "missing",
            decision: null,
          },
          ...summaries,
        ]}
      />,
    );
    await screen.findByRole("combobox", { name: "Scenario" });
    expect(
      (
        screen.getByRole("combobox", {
          name: "Saved suite",
        }) as HTMLSelectElement
      ).value,
    ).toBe(report.suite_id);
    expect(
      fetch.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/reports/external/"),
      ),
    ).toHaveLength(1);
  });
  it("opens saved external evidence from the initial screen and renders the exact failed trial", async () => {
    const report = suite();
    const { fetch } = setup([report]);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("combobox", { name: "Scenario" });
    expect(screen.queryByText("Offline verified")).toBeNull();
    expect(screen.getByText(/Model test double was used/)).toBeTruthy();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Scenario" }),
      "refund-timeout-after-side-effect",
    );
    expect(screen.getByText("Verdict: FAIL")).toBeTruthy();
    const finance = screen.getByRole("region", {
      name: "Authorisation and observed refunds",
    });
    expect(within(finance).getByText("INR 499.00 once")).toBeTruthy();
    expect(
      within(finance).getByText("2 refunds · INR 998.00 total"),
    ).toBeTruthy();
    expect(within(finance).getAllByText("INR 499.00")).toHaveLength(3);
    expect(
      screen.getByText(/1 model tool selection · 2 refund payment requests/),
    ).toBeTruthy();
    const duplicate = report.runs[1]?.report;
    expect(duplicate).toBeTruthy();
    expect(
      screen.getByText(duplicate?.final_claim.message ?? "missing"),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /Event 16 Application retry/ }),
    );
    const inspector = screen.getByRole("region", { name: "Application retry" });
    expect(within(inspector).getByText("event_after_16")).toBeTruthy();
    expect(
      within(inspector).getByText(/"previous_call_id": "call_after_1"/),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /Event 19 Second refund created/ }),
    );
    expect(
      screen.getAllByText("DUPLICATE_FINANCIAL_EFFECT").length,
    ).toBeGreaterThan(1);
    await user.click(
      screen.getByRole("button", { name: "Inspect original claim event" }),
    );
    expect(screen.getByText(/"source": "agent"/)).toBeTruthy();
    expect(
      fetch.mock.calls.every(([input]) => !String(input).includes("razorpay")),
    ).toBe(true);
  });

  it("selects by suite, scenario and trial even when deterministic run IDs repeat", async () => {
    const first = suite();
    const second = suite();
    second.suite_id = "external_second";
    second.model_execution = "openai";
    const original = second.runs[0];
    if (!original) throw new Error("fixture missing");
    const repeat = structuredClone(original);
    repeat.report.run_number = 2;
    repeat.report.final_claim.message = "Distinct repeated-trial claim.";
    second.runs.push(repeat);
    const { summaries } = setup([first, second]);
    const user = userEvent.setup();
    render(<ExternalView summaries={summaries} />);
    await screen.findByRole("combobox", { name: "Scenario" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved suite" }),
      second.suite_id,
    );
    await screen.findByText(/Live OpenAI inference was used/);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Trial" }),
      "2",
    );
    expect(
      screen.getByText("Distinct repeated-trial claim.", {
        selector: "blockquote",
      }),
    ).toBeTruthy();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved suite" }),
      first.suite_id,
    );
    await screen.findByText(/Model test double was used/);
    expect(screen.queryByText("Distinct repeated-trial claim.")).toBeNull();
    expect(
      (screen.getByRole("combobox", { name: "Trial" }) as HTMLSelectElement)
        .value,
    ).toBe("1");
  });

  it("keeps stale fetch results from replacing a newly selected suite", async () => {
    const first = suite();
    const second = suite();
    second.suite_id = "external_second";
    let finishFirst: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith(first.suite_id)
          ? new Promise<Response>((resolve) => {
              finishFirst = resolve;
            })
          : response({ report: second }),
      ),
    );
    const user = userEvent.setup();
    render(<ExternalView summaries={[summary(first), summary(second)]} />);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved suite" }),
      second.suite_id,
    );
    await screen.findByText(second.suite_id, { selector: "dd" });
    finishFirst?.(new Response(JSON.stringify({ report: first })));
    await waitFor(() =>
      expect(screen.queryByText(first.suite_id, { selector: "dd" })).toBeNull(),
    );
  });

  it("separates execution errors and fallback claims from financial violations", async () => {
    const report = suite();
    const run = report.runs[0]?.report;
    if (!run) throw new Error("fixture missing");
    run.result = "fail";
    run.deployment_decision = "block";
    run.agent_error = {
      code: "MODEL_REQUEST_FAILED",
      message: "Recorded model outage.",
    };
    run.final_claim_source = "eigen_failure_fallback";
    run.final_claim.message = "Eigen failure fallback.";
    run.trace = run.trace.filter((event) => event.type !== "agent.final_claim");
    const { summaries } = setup([report]);
    render(<ExternalView summaries={summaries} />);
    await screen.findByRole("heading", {
      name: "Application / model execution error",
    });
    expect(
      screen.getByRole("heading", { name: "Eigen-generated fallback claim" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/No financial violation is demonstrated/),
    ).toBeTruthy();
    expect(
      screen.getByText("Original claim event is missing from the trace."),
    ).toBeTruthy();
  });

  it("exposes missing evidence without inventing a complete chain, and keeps the full trace available", async () => {
    const report = suite();
    const run = report.runs[1]?.report;
    if (!run) throw new Error("fixture missing");
    run.trace = run.trace.filter((event) => event.id !== "event_after_12");
    const { summaries } = setup([report]);
    const user = userEvent.setup();
    render(<ExternalView summaries={summaries} />);
    await screen.findByRole("combobox", { name: "Scenario" });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Scenario" }),
      run.scenario_id,
    );
    expect(screen.getByText("Missing evidence: event_after_12")).toBeTruthy();
    expect(
      screen.queryByText(
        "The linked events show an application retry after the first refund response was lost.",
      ),
    ).toBeNull();
    const fullTrace = screen.getByText(/Full trace \(/);
    await user.click(fullTrace);
    expect(fullTrace.closest("details")?.open).toBe(true);
  });

  it("shows empty history and explicit malformed report errors", async () => {
    const view = render(<ExternalView summaries={[]} />);
    expect(
      screen.getByRole("heading", { name: "No saved external suites" }),
    ).toBeTruthy();
    view.unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response({ error: "Malformed external report." }, 422)),
    );
    render(
      <ExternalView
        summaries={[
          {
            ...summary(suite()),
            availability: "malformed",
            message: "Malformed external report.",
          },
        ]}
      />,
    );
    expect(
      await screen.findByRole("heading", {
        name: "External evidence unavailable",
      }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Malformed external report.").length,
    ).toBeGreaterThan(0);
  });
});
