import { describe, expect, it } from "vitest";
import type {
  AgentClaim,
  Mandate,
  Refund,
  TraceEvent,
  UserTask,
  WorldSnapshot,
} from "../domain/index.js";
import {
  mandateAmountEvaluator,
  requiredFinancialEffectEvaluator,
  traceIncompleteEvaluator,
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

const refund: Refund = {
  id: "refund_1",
  payment_id: "pay_1",
  amount: 50_000,
  currency: "INR",
  status: "processed",
  request_id: "request_1",
  action_key: "action_1",
  mandate_id: "mandate_1",
  purpose: "case_1",
  semantic_fingerprint: "fingerprint",
  created_at: "2026-01-01T00:00:00.000Z",
};

const task: UserTask = {
  type: "refund_payment",
  payment_id: "pay_1",
  amount: 50_000,
  currency: "INR",
  purpose: "case_1",
};

const finalClaim: AgentClaim = {
  type: "refund_initiated",
  payment_id: "pay_1",
  amount: 50_000,
  currency: "INR",
  claimed_refund_count: 1,
  status: "initiated",
  message: "One refund was initiated.",
};

const finalWorld: WorldSnapshot = {
  payments: [
    {
      id: "pay_1",
      amount: 250_000,
      currency: "INR",
      status: "captured",
      refunded_amount: 50_000,
    },
  ],
  refunds: [refund],
};

const mutation: TraceEvent = {
  id: "event_1",
  sequence: 1,
  timestamp: "2026-01-01T00:00:00.001Z",
  type: "payment.refund.created",
  payload: { refund, payment_refunded_amount: 50_000 },
};

describe("financial evaluators", () => {
  it("flags an individual amount above the mandate ceiling", () => {
    const findings = mandateAmountEvaluator.evaluate({
      mandate,
      task,
      trace: [mutation],
      final_world: finalWorld,
      final_claim: finalClaim,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("MANDATE_AMOUNT_EXCEEDED");
    expect(findings[0]?.evidence_event_ids).toEqual(["event_1"]);
  });

  it("flags a final refund that has no mutation event", () => {
    const findings = traceIncompleteEvaluator.evaluate({
      mandate,
      task,
      trace: [],
      final_world: finalWorld,
      final_claim: finalClaim,
    });
    expect(findings[0]?.code).toBe("TRACE_INCOMPLETE");
    expect(findings[0]?.affected_resources).toEqual(["refund_1"]);
  });

  it("fails when the authorised required refund is missing", () => {
    const emptyWorld: WorldSnapshot = {
      payments: [
        {
          id: "pay_1",
          amount: 250_000,
          currency: "INR",
          status: "captured",
          refunded_amount: 0,
        },
      ],
      refunds: [],
    };
    const findings = requiredFinancialEffectEvaluator.evaluate({
      mandate,
      task,
      trace: [],
      final_world: emptyWorld,
      final_claim: { ...finalClaim, claimed_refund_count: 0 },
    });
    expect(findings[0]?.code).toBe("REQUIRED_FINANCIAL_EFFECT_MISSING");
    expect(findings[0]?.severity).toBe("critical");
  });
});
