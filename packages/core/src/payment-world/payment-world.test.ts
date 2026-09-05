import { describe, expect, it } from "vitest";
import {
  DeterministicClock,
  DeterministicIdGenerator,
  type Mandate,
  TraceRecorder,
} from "../domain/index.js";
import {
  AmbiguousPaymentError,
  FaultInjectingPaymentProvider,
  PaymentWorld,
} from "./index.js";

const mandate: Mandate = {
  id: "mandate_1",
  action: "create_refund",
  resource_id: "pay_1",
  maximum_amount: 49_900,
  currency: "INR",
  maximum_executions: 1,
  approval_required: false,
  purpose: "case_1",
};

function createWorld(
  faultType:
    | "timeout_after_side_effect"
    | "timeout_before_side_effect" = "timeout_after_side_effect",
) {
  const clock = new DeterministicClock(42);
  const ids = new DeterministicIdGenerator(42);
  const trace = new TraceRecorder(clock, ids);
  const payments = [
    {
      id: "pay_1",
      amount: 250_000,
      currency: "INR",
      status: "captured",
      refunded_amount: 0,
    },
  ];
  const base = new PaymentWorld({
    payments,
    ids,
    clock,
  });
  const world = new FaultInjectingPaymentProvider({
    provider: base,
    faults: [
      {
        type: faultType,
        operation: "create_refund",
        occurrence: 1,
      },
    ],
    trace,
    initialWorld: { payments, refunds: [] },
  });
  return { world, trace, snapshot: () => base.snapshot() };
}

describe("PaymentWorld", () => {
  it("commits before raising an ambiguous post-side-effect timeout", async () => {
    const { world, trace, snapshot } = createWorld();
    await expect(
      world.createRefund({
        payment_id: "pay_1",
        amount: 49_900,
        currency: "INR",
        purpose: "case_1",
        request_id: "request_001",
        action_key: "action_001",
        call_id: "call_001",
        mandate,
      }),
    ).rejects.toBeInstanceOf(AmbiguousPaymentError);

    expect(snapshot().refunds).toHaveLength(1);
    const mutation = trace
      .events()
      .find((event) => event.type === "payment.refund.created");
    const fault = trace
      .events()
      .find((event) => event.type === "fault.injected");
    expect(mutation?.sequence).toBeLessThan(fault?.sequence ?? 0);
  });

  it("allows the valid partial-refund retry and preserves semantic identity", async () => {
    const { world, snapshot: takeSnapshot } = createWorld();
    await expect(
      world.createRefund({
        payment_id: "pay_1",
        amount: 49_900,
        currency: "INR",
        purpose: "case_1",
        request_id: "request_001",
        action_key: "action_001",
        call_id: "call_001",
        mandate,
      }),
    ).rejects.toBeInstanceOf(AmbiguousPaymentError);
    await world.createRefund({
      payment_id: "pay_1",
      amount: 49_900,
      currency: "INR",
      purpose: "case_1",
      request_id: "request_002",
      action_key: "action_002",
      call_id: "call_002",
      mandate,
    });

    const snapshot = takeSnapshot();
    expect(snapshot.payments[0]?.refunded_amount).toBe(99_800);
    expect(snapshot.refunds).toHaveLength(2);
    expect(snapshot.refunds[0]?.semantic_fingerprint).toBe(
      snapshot.refunds[1]?.semantic_fingerprint,
    );
  });

  it("rejects a refund that exceeds the remaining captured amount", async () => {
    const { world, snapshot } = createWorld();
    await expect(
      world.createRefund({
        payment_id: "pay_1",
        amount: 250_001,
        currency: "INR",
        purpose: "case_1",
        request_id: "request_001",
        action_key: "action_001",
        call_id: "call_001",
        mandate,
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_CAPTURED_AMOUNT" });
    expect(snapshot().refunds).toHaveLength(0);
  });

  it("returns the original refund for the same action key", async () => {
    const { world, trace, snapshot } = createWorld();
    const input = {
      payment_id: "pay_1",
      amount: 49_900,
      currency: "INR",
      purpose: "case_1",
      request_id: "request_001",
      action_key: "stable_action",
      call_id: "call_001",
      mandate,
    };
    await expect(world.createRefund(input)).rejects.toBeInstanceOf(
      AmbiguousPaymentError,
    );
    const existing = await world.createRefund({
      ...input,
      request_id: "request_002",
      call_id: "call_002",
    });

    expect(snapshot().refunds).toHaveLength(1);
    expect(existing.action_key).toBe("stable_action");
    expect(
      trace
        .events()
        .some((event) => event.type === "payment.refund.deduplicated"),
    ).toBe(true);
  });

  it("times out before mutation and allows one safe retry", async () => {
    const { world, trace, snapshot } = createWorld(
      "timeout_before_side_effect",
    );
    const input = {
      payment_id: "pay_1",
      amount: 49_900,
      currency: "INR",
      purpose: "case_1",
      request_id: "request_001",
      action_key: "stable_action",
      call_id: "call_001",
      mandate,
    };
    await expect(world.createRefund(input)).rejects.toBeInstanceOf(
      AmbiguousPaymentError,
    );
    expect(snapshot().refunds).toHaveLength(0);

    await world.createRefund({ ...input, call_id: "call_002" });
    expect(snapshot().refunds).toHaveLength(1);
    const fault = trace
      .events()
      .find((event) => event.type === "fault.injected");
    expect(fault?.payload.refund_id).toBeUndefined();
  });
});
