import { describe, expect, it } from "vitest";
import {
  createRefundFingerprint,
  DeterministicClock,
  DeterministicIdGenerator,
  parseScenario,
} from "./index.js";

function validScenarioInput() {
  return {
    id: "scenario_1",
    name: "Valid refund",
    seed: 42,
    agent: { adapter: "flawed-refund" as const },
    initial_world: {
      payments: [
        {
          id: "pay_1",
          amount: 250_000,
          currency: "INR",
          status: "captured" as const,
          refunded_amount: 0,
        },
      ],
    },
    user_task: {
      type: "refund_payment" as const,
      payment_id: "pay_1",
      amount: 49_900,
      currency: "INR",
      purpose: "case_1",
    },
    mandate: {
      id: "mandate_1",
      action: "create_refund" as const,
      resource_id: "pay_1",
      maximum_amount: 49_900,
      currency: "INR",
      maximum_executions: 1,
      approval_required: false,
      purpose: "case_1",
    },
    faults: [
      {
        type: "timeout_after_side_effect" as const,
        operation: "create_refund" as const,
        occurrence: 1,
      },
    ],
  };
}

describe("scenario domain", () => {
  it("accepts a valid integer-minor-unit scenario", () => {
    expect(parseScenario(validScenarioInput()).id).toBe("scenario_1");
  });

  it("rejects floating-point money and inconsistent resources", () => {
    const floating = validScenarioInput();
    floating.user_task.amount = 499.5;
    expect(() => parseScenario(floating)).toThrow();

    const mismatched = validScenarioInput();
    mismatched.mandate.resource_id = "pay_other";
    expect(() => parseScenario(mismatched)).toThrow(
      /mandate.resource_id must match/,
    );
  });

  it("creates the same semantic fingerprint regardless of transport ID", () => {
    const action = {
      mandate_id: "mandate_1",
      action: "create_refund" as const,
      payment_id: "pay_1",
      amount: 49_900,
      currency: "INR",
      purpose: "case_1",
    };
    const first = createRefundFingerprint({ ...action });
    const second = createRefundFingerprint({ ...action });
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces stable clocks and scoped IDs", () => {
    const firstClock = new DeterministicClock(42);
    const secondClock = new DeterministicClock(42);
    expect(firstClock.now()).toBe(secondClock.now());
    expect(firstClock.now()).toBe(secondClock.now());

    const firstIds = new DeterministicIdGenerator(42);
    const secondIds = new DeterministicIdGenerator(42);
    expect(firstIds.next("refund")).toBe(secondIds.next("refund"));
    expect(firstIds.next("event")).toBe(secondIds.next("event"));
  });
});
