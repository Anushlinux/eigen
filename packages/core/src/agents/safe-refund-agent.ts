import { type AgentClaim, createRefundFingerprint } from "../domain/index.js";
import { AmbiguousResultError } from "../payment-world/index.js";
import type { AgentAdapter, AgentRunInput } from "./flawed-refund-agent.js";

export class SafeRefundAgent implements AgentAdapter {
  readonly id = "safe-refund";

  async run(input: AgentRunInput): Promise<AgentClaim> {
    input.emitMessage("I will initiate the requested refund safely.");
    const actionKey = createRefundFingerprint({
      mandate_id: input.mandate.id,
      action: "create_refund",
      payment_id: input.task.payment_id,
      amount: input.task.amount,
      currency: input.task.currency,
      purpose: input.task.purpose,
    });
    const refundInput = {
      payment_id: input.task.payment_id,
      amount: input.task.amount,
      currency: input.task.currency,
      purpose: input.task.purpose,
      request_id: `request_${actionKey.slice(0, 12)}`,
      action_key: actionKey,
    };

    try {
      await input.tools.createRefund(refundInput);
    } catch (error) {
      if (!(error instanceof AmbiguousResultError)) throw error;

      input.emitMessage(
        "The result was ambiguous, so I will reconcile authoritative refund state.",
      );
      const reconciled = await input.tools.fetchRefundsForPayment({
        payment_id: input.task.payment_id,
        semantic_action_key: actionKey,
      });
      const existing = reconciled.find(
        (refund) => refund.semantic_fingerprint === actionKey,
      );
      if (!existing) {
        input.emitMessage(
          "No matching refund exists, so I will retry once with the same action key.",
        );
        await input.tools.createRefund(refundInput);
      }
    }

    const authoritativeRefunds = await input.tools.fetchRefundsForPayment({
      payment_id: input.task.payment_id,
      semantic_action_key: actionKey,
    });
    const matchingRefunds = authoritativeRefunds.filter(
      (refund) => refund.semantic_fingerprint === actionKey,
    );
    if (matchingRefunds.length === 0) {
      throw new Error(
        "Authoritative state does not contain the required refund",
      );
    }
    const totalRefunded = authoritativeRefunds.reduce(
      (total, refund) => total + refund.amount,
      0,
    );

    return {
      status: "completed",
      paymentId: input.task.payment_id,
      refundIds: authoritativeRefunds.map((refund) => refund.id),
      amount: input.task.amount,
      currency: input.task.currency,
      message: `Authoritative payment state shows ${authoritativeRefunds.length} processed refund totaling ${totalRefunded} ${input.task.currency} minor units.`,
    };
  }
}
