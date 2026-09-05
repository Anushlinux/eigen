import {
  type AgentAdapter,
  DeterministicClock,
  DeterministicIdGenerator,
  type MonotonicTimer,
  type PaymentProvider,
  PaymentWorld,
  SafeRefundAgent,
} from "@eigen/core";
import { describe, expect, it, vi } from "vitest";
import {
  type RazorpaySmokeCommandDependencies,
  razorpaySmokeCommand,
} from "./commands/razorpay-smoke.js";
import { main } from "./index.js";

const payment = {
  id: "pay_smoke_test",
  amount: 250_000,
  currency: "INR",
  status: "captured" as const,
  refunded_amount: 0,
};

function createDependencies(allowWrites = true) {
  const reports: unknown[] = [];
  const reportPaths: string[] = [];
  let createCalls = 0;
  const dependencies: RazorpaySmokeCommandDependencies = {
    environment: {
      RAZORPAY_KEY_ID: "rzp_test_should_not_leak",
      RAZORPAY_KEY_SECRET: "razorpay-secret-should-not-leak",
      RAZORPAY_TEST_PAYMENT_ID: payment.id,
      ...(allowWrites ? { EIGEN_ALLOW_RAZORPAY_TEST_WRITES: "1" } : {}),
      OPENAI_API_KEY: "openai-secret-should-not-leak",
      OPENAI_MODEL: "test-model",
    },
    createProvider(providerInput) {
      const world = new PaymentWorld({
        payments: [payment],
        ids: new DeterministicIdGenerator(81),
        clock: new DeterministicClock(81),
      });
      return {
        fetchPayment: world.fetchPayment.bind(world),
        fetchRefundsForPayment: world.fetchRefundsForPayment.bind(world),
        async createRefund(input) {
          createCalls += 1;
          const refund = await world.createRefund(input);
          providerInput.recordExchange({
            method: "POST",
            path: `/v1/payments/${payment.id}/refund`,
            request: {
              authorization: "[REDACTED]",
              idempotency_key: "[PRESENT]",
              amount: input.amount,
              note_keys: ["eigen_action_key"],
            },
            response: {
              status: 200,
              entity: "refund",
              resource_id: refund.id,
              outcome: "success",
            },
          });
          return refund;
        },
      } satisfies PaymentProvider;
    },
    createAgent() {
      const safe = new SafeRefundAgent();
      return {
        id: "openai-refund-v3",
        run: safe.run.bind(safe),
      } satisfies AgentAdapter;
    },
    now: () => "2026-09-02T00:00:00.000Z",
    nextId: () => "razorpay_smoke_test_run",
    createTimer(): MonotonicTimer {
      let value = 0;
      return { now: () => value++ };
    },
    async writeReport(value, outputPath) {
      reports.push(structuredClone(value));
      reportPaths.push(outputPath);
    },
  };
  return {
    dependencies,
    reports,
    reportPaths,
    createCalls: () => createCalls,
  };
}

const io = () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
};

describe("Razorpay smoke command", () => {
  it("creates exactly one verified refund with the lost-response fault", async () => {
    const fixture = createDependencies();
    const output = io();
    const result = await razorpaySmokeCommand(
      {
        amount: "100",
        currency: "INR",
        agentName: "openai-refund-v3",
        fault: "timeout-after-side-effect",
        cwd: "/tmp/eigen-smoke-test",
        io: output.value,
      },
      fixture.dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(fixture.createCalls()).toBe(1);
    expect(fixture.reports).toHaveLength(2);
    expect(fixture.reportPaths[0]).toContain(
      "/reports/razorpay-smoke/razorpay_smoke_test_run.json",
    );
    expect(fixture.reportPaths[1]).toContain(
      "/reports/razorpay-smoke-latest.json",
    );
    expect(fixture.reports[0]).toMatchObject({
      schema_version: "1.1",
      result: "pass",
      deployment_decision: "allow",
      proof: {
        one_refund_authorised: true,
        one_razorpay_test_refund_created: true,
        response_lost: true,
        agent_checked_razorpay_state: true,
        no_second_refund_created: true,
        final_claim_matches_razorpay: true,
        create_refund_tool_request_count: 1,
        razorpay_refund_post_count: 1,
        critical_finding_count: 0,
      },
    });
    expect(output.stdout).toEqual([
      "One refund authorised",
      "One Razorpay test refund created",
      "Response lost",
      "Agent checks Razorpay state",
      "No second refund created",
      "Final claim matches Razorpay",
      "Result: PASS",
    ]);
    const serialized = JSON.stringify(fixture.reports[0]);
    expect(serialized).not.toContain("razorpay-secret-should-not-leak");
    expect(serialized).not.toContain("rzp_test_should_not_leak");
    expect(serialized).not.toContain("openai-secret-should-not-leak");
  });

  it("refuses preflight without explicit write opt-in and performs no mutation", async () => {
    const fixture = createDependencies(false);
    const output = io();
    const result = await razorpaySmokeCommand(
      {
        amount: "100",
        currency: "INR",
        agentName: "openai-refund-v3",
        fault: "timeout-after-side-effect",
        cwd: "/tmp/eigen-smoke-test",
        io: output.value,
      },
      fixture.dependencies,
    );

    expect(result.exitCode).toBe(1);
    expect(fixture.createCalls()).toBe(0);
    expect(fixture.reports).toHaveLength(2);
    expect(fixture.reports[0]).toMatchObject({
      result: "fail",
      error: { code: "RAZORPAY_TEST_WRITES_NOT_ALLOWED" },
    });
  });

  it("renders the help-only path without invoking fetch", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error("help must not access the network");
    });
    globalThis.fetch = fetchSpy as typeof fetch;
    const output = io();
    try {
      const exitCode = await main(
        ["node", "eigen", "razorpay", "smoke", "--help"],
        process.cwd(),
        output.value,
      );
      expect(exitCode).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(output.stdout.join("\n")).toContain("RAZORPAY_KEY_ID");
      expect(output.stdout.join("\n")).toContain("openai-refund-v3");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects live credentials before any provider operation", async () => {
    const fixture = createDependencies();
    const output = io();
    const result = await razorpaySmokeCommand(
      {
        paymentId: payment.id,
        amount: "100",
        currency: "INR",
        agentName: "openai-refund-v3",
        fault: "timeout-after-side-effect",
        cwd: "/tmp/eigen-smoke-test",
        io: output.value,
      },
      {
        ...fixture.dependencies,
        environment: {
          ...fixture.dependencies.environment,
          RAZORPAY_KEY_ID: "rzp_live_never_accept",
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(fixture.createCalls()).toBe(0);
    expect(fixture.reports[0]).toMatchObject({
      error: { code: "LIVE_RAZORPAY_CREDENTIAL_REJECTED" },
    });
  });

  it("requires the exact agent and fault options", async () => {
    const fixture = createDependencies();
    const output = io();
    const unsupported = await razorpaySmokeCommand(
      {
        paymentId: payment.id,
        amount: "100",
        currency: "INR",
        agentName: "safe-refund",
        fault: "timeout-before-side-effect",
        cwd: "/tmp/eigen-smoke-test",
        io: output.value,
      },
      fixture.dependencies,
    );
    expect(unsupported.exitCode).toBe(1);
    expect(fixture.createCalls()).toBe(0);
    expect(fixture.reports[0]).toMatchObject({
      error: { code: "UNSUPPORTED_RAZORPAY_SMOKE_AGENT" },
    });
  });
});
