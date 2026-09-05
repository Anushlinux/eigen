import {
  DeterministicClock,
  DeterministicIdGenerator,
  type Mandate,
  type PaymentProvider,
  PaymentWorld,
} from "@eigen/core";
import { describe, expect, it } from "vitest";
import {
  type RazorpayHttpRequest,
  type RazorpayHttpResponse,
  type RazorpayHttpTransport,
  RazorpayTestAdapter,
  validateRazorpayEnvironment,
} from "./index.js";

const payment = {
  id: "pay_test_1",
  entity: "payment",
  amount: 250_000,
  currency: "INR",
  status: "captured",
  amount_refunded: 0,
};

const mandate: Mandate = {
  id: "mandate_test_1",
  action: "create_refund",
  resource_id: payment.id,
  maximum_amount: 49_900,
  currency: "INR",
  maximum_executions: 1,
  approval_required: false,
  purpose: "case_test_1",
};

function refundResponse(
  id: string,
  actionKey = "stable_action_001",
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    entity: "refund",
    amount: 49_900,
    currency: "INR",
    payment_id: payment.id,
    status: "processed",
    created_at: 1_788_192_000,
    receipt: null,
    notes: {
      eigen_run_id: "run_test_1",
      eigen_mandate_id: mandate.id,
      eigen_action_key: actionKey,
      eigen_fingerprint: actionKey,
      eigen_purpose: mandate.purpose,
    },
    ...overrides,
  };
}

class StatefulTransport implements RazorpayHttpTransport {
  readonly requests: RazorpayHttpRequest[] = [];
  readonly refunds: Array<Record<string, unknown>> = [];
  postCount = 0;
  forcedResponse?: RazorpayHttpResponse;
  transportFailure = false;

  async request(input: RazorpayHttpRequest): Promise<RazorpayHttpResponse> {
    this.requests.push(structuredClone(input));
    if (this.transportFailure) throw new Error("network unavailable");
    if (this.forcedResponse) return this.forcedResponse;
    if (input.method === "GET" && input.path === `/v1/payments/${payment.id}`) {
      return { status: 200, headers: {}, body: structuredClone(payment) };
    }
    if (input.method === "GET" && input.path.includes("/refunds?")) {
      const skip = Number(
        new URL(`https://example.test${input.path}`).searchParams.get("skip"),
      );
      const items = this.refunds.slice(skip, skip + 100);
      return {
        status: 200,
        headers: {},
        body: { entity: "collection", count: items.length, items },
      };
    }
    if (input.method === "POST" && input.path.endsWith("/refund")) {
      this.postCount += 1;
      const body = input.body as {
        amount: number;
        notes: Record<string, string>;
      };
      const refund = refundResponse(
        `rfnd_test_${this.postCount}`,
        body.notes.eigen_action_key,
        {
          amount: body.amount,
          notes: body.notes,
        },
      );
      this.refunds.push(refund);
      payment.amount_refunded = this.refunds.reduce(
        (sum, entry) => sum + Number(entry.amount),
        0,
      );
      return { status: 200, headers: {}, body: refund };
    }
    return {
      status: 404,
      headers: {},
      body: { error: { code: "BAD_REQUEST_ERROR" } },
    };
  }
}

function createAdapter(
  transport = new StatefulTransport(),
  recordExchange?: ConstructorParameters<
    typeof RazorpayTestAdapter
  >[0]["recordExchange"],
) {
  return {
    adapter: new RazorpayTestAdapter({
      keyId: "rzp_test_example",
      keySecret: "test-secret-must-not-leak",
      runId: "run_test_1",
      transport,
      ...(recordExchange ? { recordExchange } : {}),
    }),
    transport,
  };
}

function createInput(actionKey = "stable_action_001") {
  return {
    payment_id: payment.id,
    amount: 49_900,
    currency: "INR",
    purpose: mandate.purpose,
    request_id: "request_test_1",
    action_key: actionKey,
    call_id: "call_test_1",
    mandate,
  };
}

describe("Razorpay Test Mode configuration", () => {
  it("rejects missing and live credentials", () => {
    expect(() => validateRazorpayEnvironment({})).toThrowError(
      expect.objectContaining({ code: "RAZORPAY_KEY_ID_MISSING" }),
    );
    expect(() =>
      validateRazorpayEnvironment({
        RAZORPAY_KEY_ID: "rzp_live_never",
        RAZORPAY_KEY_SECRET: "secret",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "LIVE_RAZORPAY_CREDENTIAL_REJECTED" }),
    );
  });

  it("accepts only a complete test credential pair", () => {
    expect(
      validateRazorpayEnvironment({
        RAZORPAY_KEY_ID: "rzp_test_example",
        RAZORPAY_KEY_SECRET: "secret",
      }),
    ).toEqual({ keyId: "rzp_test_example", keySecret: "secret" });
    expect(() =>
      validateRazorpayEnvironment({ RAZORPAY_KEY_ID: "rzp_test_example" }),
    ).toThrowError(
      expect.objectContaining({ code: "RAZORPAY_KEY_SECRET_MISSING" }),
    );
    expect(() =>
      validateRazorpayEnvironment({
        RAZORPAY_KEY_ID: "merchant_key_unknown",
        RAZORPAY_KEY_SECRET: "secret",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "RAZORPAY_TEST_KEY_REQUIRED" }),
    );
  });
});

describe("RazorpayTestAdapter", () => {
  it("maps payment and correlated refund responses", async () => {
    const { adapter, transport } = createAdapter();
    transport.refunds.push(refundResponse("rfnd_existing"));
    const mappedPayment = await adapter.fetchPayment({
      payment_id: payment.id,
    });
    const refunds = await adapter.fetchRefundsForPayment({
      payment_id: payment.id,
    });

    expect(mappedPayment).toMatchObject({
      id: payment.id,
      amount: 250_000,
      currency: "INR",
      status: "captured",
    });
    expect(refunds[0]).toMatchObject({
      id: "rfnd_existing",
      action_key: "stable_action_001",
      mandate_id: mandate.id,
      purpose: mandate.purpose,
      status: "processed",
    });
  });

  it("creates one refund and resolves an idempotent retry without another POST", async () => {
    payment.amount_refunded = 0;
    const { adapter, transport } = createAdapter();
    const first = await adapter.createRefund(createInput());
    const second = await adapter.createRefund(createInput());

    expect(first.id).toBe(second.id);
    expect(transport.postCount).toBe(1);
    const post = transport.requests.find(
      (request) => request.method === "POST",
    );
    expect(post?.headers["X-Refund-Idempotency"]).toBe("stable_action_001");
    expect(post?.body).toMatchObject({
      amount: 49_900,
      notes: {
        eigen_action_key: "stable_action_001",
        eigen_mandate_id: mandate.id,
      },
    });
  });

  it("rejects an action key already attached to a different refund intention", async () => {
    const { adapter, transport } = createAdapter();
    transport.refunds.push(
      refundResponse("rfnd_conflicting", "stable_action_001", { amount: 100 }),
    );
    await expect(adapter.createRefund(createInput())).rejects.toMatchObject({
      code: "ACTION_KEY_CONFLICT",
      category: "conflict",
    });
    expect(transport.postCount).toBe(0);
  });

  it("rejects over-refunds before POST", async () => {
    payment.amount_refunded = 240_000;
    const { adapter, transport } = createAdapter();
    await expect(adapter.createRefund(createInput())).rejects.toMatchObject({
      code: "REFUND_EXCEEDS_CAPTURED_AMOUNT",
    });
    expect(transport.postCount).toBe(0);
    payment.amount_refunded = 0;
  });

  it("maps remote errors and ambiguous write transport failures", async () => {
    const remote = new StatefulTransport();
    remote.forcedResponse = {
      status: 401,
      headers: {},
      body: { error: { code: "BAD_REQUEST_ERROR" } },
    };
    await expect(
      createAdapter(remote).adapter.fetchPayment({ payment_id: payment.id }),
    ).rejects.toMatchObject({
      code: "RAZORPAY_AUTHENTICATION_FAILED",
      category: "authentication",
    });

    const failing = new StatefulTransport();
    const adapter = createAdapter(failing).adapter;
    failing.refunds.push();
    const originalRequest = failing.request.bind(failing);
    failing.request = async (input) => {
      if (input.method === "POST") throw new Error("lost response");
      return originalRequest(input);
    };
    await expect(adapter.createRefund(createInput())).rejects.toMatchObject({
      code: "AMBIGUOUS_RESULT",
      ambiguous: true,
    });
  });

  it.each([
    [409, "RAZORPAY_CONFLICT", "conflict"],
    [429, "RAZORPAY_RATE_LIMITED", "rate_limit"],
    [503, "RAZORPAY_UNAVAILABLE", "unavailable"],
  ])("maps status %s into %s", async (status, code, category) => {
    const transport = new StatefulTransport();
    transport.forcedResponse = {
      status,
      headers: {},
      body: { error: { code: "SERVER_ERROR" } },
    };
    await expect(
      createAdapter(transport).adapter.fetchPayment({ payment_id: payment.id }),
    ).rejects.toMatchObject({ code, category, retryable: true });
  });

  it("rejects malformed payment, refund collection, and created-refund responses", async () => {
    const malformedPayment = new StatefulTransport();
    malformedPayment.forcedResponse = { status: 200, headers: {}, body: {} };
    await expect(
      createAdapter(malformedPayment).adapter.fetchPayment({
        payment_id: payment.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RAZORPAY_RESPONSE" });

    const malformedCollection = new StatefulTransport();
    malformedCollection.forcedResponse = {
      status: 200,
      headers: {},
      body: { entity: "collection", count: 1, items: [{}] },
    };
    await expect(
      createAdapter(malformedCollection).adapter.fetchRefundsForPayment({
        payment_id: payment.id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RAZORPAY_RESPONSE" });

    const malformedCreate = new StatefulTransport();
    const originalRequest = malformedCreate.request.bind(malformedCreate);
    malformedCreate.request = async (input) => {
      if (input.method === "POST") {
        return { status: 200, headers: {}, body: { id: "rfnd_incomplete" } };
      }
      return originalRequest(input);
    };
    await expect(
      createAdapter(malformedCreate).adapter.createRefund(createInput()),
    ).rejects.toMatchObject({ code: "INVALID_RAZORPAY_RESPONSE" });
    expect(malformedCreate.postCount).toBe(0);
  });

  it("paginates all refunds and strips credentials from metadata", async () => {
    const transport = new StatefulTransport();
    for (let index = 0; index < 101; index += 1) {
      transport.refunds.push(
        refundResponse(`rfnd_${index}`, `external_action_${index}`),
      );
    }
    const exchanges: unknown[] = [];
    const { adapter } = createAdapter(transport, (metadata) =>
      exchanges.push(metadata),
    );
    const refunds = await adapter.fetchRefundsForPayment({
      payment_id: payment.id,
    });
    const serialized = JSON.stringify(exchanges);

    expect(refunds).toHaveLength(101);
    expect(
      transport.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(2);
    expect(serialized).not.toContain("test-secret-must-not-leak");
    expect(serialized).not.toContain("rzp_test_example");
    expect(serialized).toContain("[REDACTED]");
  });
});

describe.each([
  [
    "PaymentWorld",
    () => {
      const world = new PaymentWorld({
        payments: [
          { ...payment, status: "captured" as const, refunded_amount: 0 },
        ],
        ids: new DeterministicIdGenerator(7),
        clock: new DeterministicClock(7),
      });
      return { provider: world as PaymentProvider, posts: () => 1 };
    },
  ],
  [
    "RazorpayTestAdapter",
    () => {
      payment.amount_refunded = 0;
      const created = createAdapter();
      return {
        provider: created.adapter as PaymentProvider,
        posts: () => created.transport.postCount,
      };
    },
  ],
])("shared provider contract: %s", (_name, factory) => {
  it("preserves core partial-refund and idempotency semantics", async () => {
    const { provider, posts } = factory();
    const fetched = await provider.fetchPayment({ payment_id: payment.id });
    const first = await provider.createRefund(createInput());
    const second = await provider.createRefund(createInput());
    const refunds = await provider.fetchRefundsForPayment({
      payment_id: payment.id,
    });

    expect(fetched).toMatchObject({
      id: payment.id,
      amount: 250_000,
      currency: "INR",
      status: "captured",
    });
    expect(first.id).toBe(second.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      payment_id: payment.id,
      amount: 49_900,
      currency: "INR",
    });
    expect(posts()).toBe(1);
  });
});
