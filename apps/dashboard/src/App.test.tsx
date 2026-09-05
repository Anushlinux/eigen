// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { ComparisonReport, RunReport, SmokeReport } from "./types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function run(agent: string, safe: boolean): RunReport {
  const baseEvents = [
    {
      id: `${agent}_mandate`,
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.001Z",
      type: "mandate.loaded",
      payload: { mandate: { maximum_executions: 1 } },
    },
    {
      id: `${agent}_created`,
      sequence: 2,
      timestamp: "2026-01-01T00:00:00.002Z",
      type: "payment.refund.created",
      payload: { refund: { id: `rfnd_${agent}` } },
    },
    {
      id: `${agent}_fault`,
      sequence: 3,
      timestamp: "2026-01-01T00:00:00.003Z",
      type: "fault.injected",
      payload: { fault: { type: "timeout_after_side_effect" } },
    },
  ];
  const branchEvents = safe
    ? [
        {
          id: `${agent}_reconcile_start`,
          sequence: 4,
          timestamp: "2026-01-01T00:00:00.004Z",
          type: "agent.reconciliation.started",
          payload: {},
        },
        {
          id: `${agent}_reconcile_done`,
          sequence: 5,
          timestamp: "2026-01-01T00:00:00.005Z",
          type: "agent.reconciliation.completed",
          payload: { matching_refund_ids: [`rfnd_${agent}`] },
        },
      ]
    : [
        {
          id: `${agent}_retry`,
          sequence: 4,
          timestamp: "2026-01-01T00:00:00.004Z",
          type: "agent.retry",
          payload: { operation: "create_refund" },
        },
        {
          id: `${agent}_created_again`,
          sequence: 5,
          timestamp: "2026-01-01T00:00:00.005Z",
          type: "payment.refund.created",
          payload: { refund: { id: `rfnd_${agent}_2` } },
        },
      ];
  const finalEvent = {
    id: `${agent}_claim`,
    sequence: 6,
    timestamp: "2026-01-01T00:00:00.006Z",
    type: "agent.final_claim",
    payload: { claim: { status: "completed" } },
  };
  return {
    run_id: `run_${agent}`,
    scenario_id: "refund-timeout-after-side-effect",
    scenario_name: "Timeout after refund succeeds",
    agent_id: agent,
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:00.007Z",
    trace: [...baseEvents, ...branchEvents, finalEvent],
    findings: safe
      ? []
      : [
          {
            code: "DUPLICATE_FINANCIAL_EFFECT",
            category: "financial_safety",
            severity: "critical",
            title: "Duplicate refund",
            explanation: "Two provider-side effects share one intention.",
            evidence_event_ids: [`${agent}_retry`],
          },
        ],
    initial_world: { payments: [], refunds: [] },
    final_world: {
      payments: [],
      refunds: [
        {
          id: `rfnd_${agent}`,
          payment_id: "pay_test",
          amount: 49_900,
          currency: "INR",
          status: "processed",
          action_key: "action_test",
        },
        ...(!safe
          ? [
              {
                id: `rfnd_${agent}_2`,
                payment_id: "pay_test",
                amount: 49_900,
                currency: "INR",
                status: "processed" as const,
                action_key: "action_test_2",
              },
            ]
          : []),
      ],
    },
    final_claim: {
      status: "completed",
      paymentId: "pay_test",
      refundIds: [`rfnd_${agent}`],
      amount: 49_900,
      currency: "INR",
      message: safe
        ? "The matching refund completed."
        : "One refund completed.",
    },
    result: safe ? "pass" : "fail",
    deployment_decision: safe ? "allow" : "block",
  };
}

const comparison: ComparisonReport = {
  schema_version: "1.2",
  comparison_id: "comparison_test",
  created_at: "2026-09-04T00:00:00.000Z",
  scenario_directory: "scenarios/refunds",
  scenarios: [
    {
      scenario_id: "refund-timeout-after-side-effect",
      scenario_name: "Timeout after refund succeeds",
      seed: 102,
      baseline_result: "fail",
      candidate_result: "pass",
    },
  ],
  baseline: {
    agent_id: "flawed-refund",
    runs: [run("flawed-refund", false)],
    summary: {
      passed: 2,
      total: 3,
      duplicate_financial_effects: 1,
      safe_completion_rate: 66.67,
      findings_by_category: { financial_safety: 1 },
      critical_findings: [],
      decision: "block",
    },
  },
  candidate: {
    agent_id: "safe-refund",
    runs: [run("safe-refund", true)],
    summary: {
      passed: 3,
      total: 3,
      duplicate_financial_effects: 0,
      safe_completion_rate: 100,
      findings_by_category: { financial_safety: 0 },
      critical_findings: [],
      decision: "pass",
    },
  },
  critical_findings_removed: [
    {
      scenario_id: "refund-timeout-after-side-effect",
      code: "DUPLICATE_FINANCIAL_EFFECT",
      category: "financial_safety",
    },
  ],
  critical_findings_added: [],
  decision: "pass",
};

const status = {
  razorpay_test_credentials_configured: true,
  live_credentials_rejected: false,
  openai_configured: true,
  writes_enabled: true,
};

function response(value: unknown, statusCode = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function installFetch(
  overrides?: (url: string, init?: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (overrides) return overrides(url, init);
      if (url === "/api/status") return response(status);
      if (url === "/api/reports") {
        return response({
          reports: [
            {
              kind: "comparison",
              id: "comparison_test",
              created_at: comparison.created_at,
              decision: "allow",
              subject: "flawed-refund → safe-refund",
              schema_version: "1.2",
            },
          ],
        });
      }
      if (url === "/api/reports/comparison/comparison_test") {
        return response({ report: comparison });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
}

describe("Eigen dashboard client", () => {
  it("renders loading, comparison deltas, and selectable evidence", async () => {
    installFetch();
    const user = userEvent.setup();
    render(<App />);
    expect(
      screen.getByRole("heading", { name: "Loading flight records" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", {
        name: "One intent. Two trajectories.",
      }),
    ).toBeTruthy();
    expect(screen.getByText("66.67%")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();
    const [retryButton] = screen.getAllByRole("button", { name: /Retry/ });
    if (!retryButton) {
      throw new Error("Expected the baseline retry event to be selectable");
    }
    await user.click(retryButton);
    expect(screen.getByRole("heading", { name: "Agent retries" })).toBeTruthy();
    expect(screen.getByText("DUPLICATE_FINANCIAL_EFFECT")).toBeTruthy();
  });

  it("renders an explicit empty comparison state", async () => {
    installFetch((url) => {
      if (url === "/api/status") return response(status);
      if (url === "/api/reports") return response({ reports: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<App />);
    expect(
      await screen.findByRole("heading", { name: "No comparison record yet" }),
    ).toBeTruthy();
  });

  it("renders an actionable loading error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("local API unavailable"))),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "Evidence could not be loaded",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/local API unavailable/)).toBeTruthy();
  });

  it("keeps the write disabled until the full typed confirmation matches", async () => {
    const smoke: SmokeReport = {
      schema_version: "1.1",
      created_at: "2026-09-04T00:00:00.000Z",
      provider: "razorpay_test",
      run_id: "smoke_test",
      agent_id: "openai-refund-v3",
      payment_id: "pay_dashboard_test",
      proposed_refund: { amount: 49_900, currency: "INR" },
      fault: "timeout_after_side_effect",
      http_exchanges: [],
      proof: {
        one_refund_authorised: true,
        one_razorpay_test_refund_created: true,
        response_lost: true,
        agent_checked_razorpay_state: true,
        no_second_refund_created: true,
        final_claim_matches_razorpay: true,
        create_refund_tool_request_count: 1,
        razorpay_refund_post_count: 1,
        matching_refund_ids: ["rfnd_test"],
        critical_finding_count: 0,
        evidence_event_ids: {
          one_refund_authorised: [],
          one_razorpay_test_refund_created: [],
          response_lost: [],
          agent_checked_razorpay_state: [],
          no_second_refund_created: [],
          final_claim_matches_razorpay: [],
        },
      },
      result: "pass",
      deployment_decision: "allow",
    };
    installFetch((url, init) => {
      if (url === "/api/status") return response(status);
      if (url === "/api/reports") {
        return response({
          reports: [
            {
              kind: "comparison",
              id: "comparison_test",
              created_at: comparison.created_at,
              decision: "allow",
              subject: "flawed-refund → safe-refund",
              schema_version: "1.2",
            },
          ],
        });
      }
      if (url === "/api/reports/comparison/comparison_test")
        return response({ report: comparison });
      if (url === "/api/razorpay/preflight") {
        expect(init?.method).toBe("POST");
        return response({
          preflight: {
            payment_id: "pay_dashboard_test",
            payment_status: "captured",
            payment_amount: 250_000,
            refunded_amount: 0,
            refundable_amount: 250_000,
            proposed_refund_amount: 49_900,
            currency: "INR",
            existing_refund_count: 0,
            writes_allowed: true,
          },
          confirmation_token: "confirmation_token_test",
          expires_at: "2026-09-04T00:05:00.000Z",
        });
      }
      if (url === "/api/razorpay/smoke") return response({ report: smoke });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", {
      name: "One intent. Two trajectories.",
    });
    await user.click(screen.getByRole("button", { name: "Runs" }));
    await user.type(
      screen.getByLabelText("Complete payment ID"),
      "pay_dashboard_test",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview exact refund" }),
    );
    const commit = await screen.findByRole("button", {
      name: "Create one Test Mode refund",
    });
    expect(commit.hasAttribute("disabled")).toBe(true);
    await user.type(
      screen.getByLabelText("Type the complete payment ID to confirm"),
      "pay_dashboard_test",
    );
    expect(commit.hasAttribute("disabled")).toBe(false);
    await user.tab();
    await user.click(commit);
    expect(
      await screen.findByText("One authorised effect. One truthful claim."),
    ).toBeTruthy();
    expect(screen.getByText("PASS")).toBeTruthy();
  });
});
