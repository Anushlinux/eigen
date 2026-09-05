import type {
  RazorpaySmokeExecution,
  RazorpaySmokePreflight,
} from "@eigen/razorpay-smoke";
import { describe, expect, it, vi } from "vitest";
import { createDashboardApi, type DashboardApiDependencies } from "./api.js";

const smokeInput = {
  paymentId: "pay_dashboard_test",
  amount: 49_900,
  currency: "INR",
  agent: "openai-refund-v3" as const,
  fault: "timeout-after-side-effect" as const,
};

const preflight: RazorpaySmokePreflight = {
  payment_id: smokeInput.paymentId,
  payment_status: "captured",
  payment_amount: 250_000,
  refunded_amount: 0,
  refundable_amount: 250_000,
  proposed_refund_amount: smokeInput.amount,
  currency: "INR",
  existing_refund_count: 0,
  writes_allowed: true,
};

function fakeExecution(): RazorpaySmokeExecution {
  return {
    historyPath: "/tmp/reports/razorpay-smoke/run_test.json",
    latestPath: "/tmp/reports/razorpay-smoke-latest.json",
    report: {
      schema_version: "1.1",
      created_at: "2026-09-04T00:00:00.000Z",
      provider: "razorpay_test",
      run_id: "run_test",
      agent_id: "openai-refund-v3",
      payment_id: smokeInput.paymentId,
      proposed_refund: { amount: smokeInput.amount, currency: "INR" },
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
          one_refund_authorised: ["event_1"],
          one_razorpay_test_refund_created: ["event_2"],
          response_lost: ["event_3"],
          agent_checked_razorpay_state: ["event_4"],
          no_second_refund_created: ["event_2"],
          final_claim_matches_razorpay: ["event_5"],
        },
      },
      result: "pass",
      deployment_decision: "allow",
    },
  };
}

function request(
  path: string,
  body: unknown,
  origin = "http://127.0.0.1:4173",
) {
  return new Request(`http://127.0.0.1:4173${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

function fixture(overrides: Partial<DashboardApiDependencies> = {}) {
  let token = 0;
  const dependencies: DashboardApiDependencies = {
    cwd: "/tmp/eigen-dashboard-api-test",
    environment: {
      RAZORPAY_KEY_ID: "rzp_test_redacted",
      RAZORPAY_KEY_SECRET: "secret-never-returned",
      OPENAI_API_KEY: "openai-never-returned",
      OPENAI_MODEL: "test-model",
      EIGEN_ALLOW_RAZORPAY_TEST_WRITES: "1",
    },
    now: () => 1_788_192_000_000,
    nextToken: () => `confirmation_token_${++token}`,
    prepare: vi.fn(async () => preflight),
    execute: vi.fn(async () => fakeExecution()),
    ...overrides,
  };
  return { dependencies, api: createDashboardApi(dependencies) };
}

async function issueToken(api: ReturnType<typeof createDashboardApi>) {
  const response = await api(request("/api/razorpay/preflight", smokeInput));
  expect(response?.status).toBe(200);
  return (await response?.json()) as { confirmation_token: string };
}

describe("dashboard API", () => {
  it("returns configuration booleans without secret values", async () => {
    const { api } = fixture();
    const response = await api(new Request("http://127.0.0.1:4173/api/status"));
    const body = await response?.text();
    expect(response?.status).toBe(200);
    expect(body).toContain('"writes_enabled":true');
    expect(body).not.toContain("secret-never-returned");
    expect(body).not.toContain("openai-never-returned");
    expect(body).not.toContain("rzp_test_redacted");
  });

  it("rejects cross-origin and non-JSON writes", async () => {
    const { api, dependencies } = fixture();
    const crossOrigin = await api(
      request(
        "/api/razorpay/preflight",
        smokeInput,
        "https://attacker.example",
      ),
    );
    const nonJson = await api(
      new Request("http://127.0.0.1:4173/api/razorpay/preflight", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "not json",
      }),
    );
    expect(crossOrigin?.status).toBe(403);
    expect(nonJson?.status).toBe(415);
    expect(dependencies.prepare).not.toHaveBeenCalled();
  });

  it("requires the matching typed payment ID and consumes tokens once", async () => {
    const { api, dependencies } = fixture();
    const first = await issueToken(api);
    const mismatch = await api(
      request("/api/razorpay/smoke", {
        confirmationToken: first.confirmation_token,
        typedPaymentId: "pay_wrong",
        input: smokeInput,
      }),
    );
    expect(mismatch?.status).toBe(409);

    const reused = await api(
      request("/api/razorpay/smoke", {
        confirmationToken: first.confirmation_token,
        typedPaymentId: smokeInput.paymentId,
        input: smokeInput,
      }),
    );
    expect(reused?.status).toBe(409);
    expect(dependencies.execute).not.toHaveBeenCalled();

    const second = await issueToken(api);
    const accepted = await api(
      request("/api/razorpay/smoke", {
        confirmationToken: second.confirmation_token,
        typedPaymentId: smokeInput.paymentId,
        input: smokeInput,
      }),
    );
    expect(accepted?.status).toBe(200);
    expect(dependencies.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects expired tokens and a disabled server write flag", async () => {
    let now = 1_788_192_000_000;
    const expiredFixture = fixture({ now: () => now });
    const token = await issueToken(expiredFixture.api);
    now += 5 * 60_000 + 1;
    const expired = await expiredFixture.api(
      request("/api/razorpay/smoke", {
        confirmationToken: token.confirmation_token,
        typedPaymentId: smokeInput.paymentId,
        input: smokeInput,
      }),
    );
    expect(expired?.status).toBe(409);

    const disabledFixture = fixture({
      environment: {
        RAZORPAY_KEY_ID: "rzp_test_example",
        RAZORPAY_KEY_SECRET: "secret",
        OPENAI_API_KEY: "openai",
        OPENAI_MODEL: "test",
      },
    });
    const disabledToken = await issueToken(disabledFixture.api);
    const disabled = await disabledFixture.api(
      request("/api/razorpay/smoke", {
        confirmationToken: disabledToken.confirmation_token,
        typedPaymentId: smokeInput.paymentId,
        input: smokeInput,
      }),
    );
    expect(disabled?.status).toBe(403);
    expect(disabledFixture.dependencies.execute).not.toHaveBeenCalled();
  });

  it("allows only one active smoke run per payment", async () => {
    let finish: ((value: RazorpaySmokeExecution) => void) | undefined;
    const pending = new Promise<RazorpaySmokeExecution>((resolve) => {
      finish = resolve;
    });
    const concurrentFixture = fixture({ execute: vi.fn(() => pending) });
    const firstToken = await issueToken(concurrentFixture.api);
    const secondToken = await issueToken(concurrentFixture.api);
    const firstRun = concurrentFixture.api(
      request("/api/razorpay/smoke", {
        confirmationToken: firstToken.confirmation_token,
        typedPaymentId: smokeInput.paymentId,
        input: smokeInput,
      }),
    );
    await Promise.resolve();
    const secondRun = await concurrentFixture.api(
      request("/api/razorpay/smoke", {
        confirmationToken: secondToken.confirmation_token,
        typedPaymentId: smokeInput.paymentId,
        input: smokeInput,
      }),
    );
    expect(secondRun?.status).toBe(409);
    finish?.(fakeExecution());
    expect((await firstRun)?.status).toBe(200);
  });
});
