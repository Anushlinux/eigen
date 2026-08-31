import type { AgentClaim, Mandate, Refund, UserTask } from "../domain/index.js";

export interface AgentCreateRefundInput {
  payment_id: string;
  amount: number;
  currency: string;
  purpose: string;
  request_id: string;
  action_key: string;
}

export interface AgentFetchRefundsInput {
  payment_id: string;
  semantic_action_key: string;
}

export interface AgentPaymentTools {
  createRefund(input: AgentCreateRefundInput): Promise<Refund>;
  fetchRefundsForPayment(input: AgentFetchRefundsInput): Promise<Refund[]>;
}

export interface AgentRunInput {
  task: UserTask;
  mandate: Mandate;
  tools: AgentPaymentTools;
  emitMessage(message: string): void;
}

export interface AgentAdapter {
  readonly id: string;
  run(input: AgentRunInput): Promise<AgentClaim>;
}

export class FlawedRefundAgent implements AgentAdapter {
  readonly id = "flawed-refund";
  private requestCount = 0;

  async run(input: AgentRunInput): Promise<AgentClaim> {
    input.emitMessage("I will initiate the requested refund.");
    const refundInput = {
      payment_id: input.task.payment_id,
      amount: input.task.amount,
      currency: input.task.currency,
      purpose: input.task.purpose,
    };

    try {
      const requestId = this.nextRequestId();
      await input.tools.createRefund({
        ...refundInput,
        request_id: requestId,
        action_key: `action_${requestId}`,
      });
    } catch {
      input.emitMessage("The first call failed, so I will retry once.");
      const requestId = this.nextRequestId();
      await input.tools.createRefund({
        ...refundInput,
        request_id: requestId,
        action_key: `action_${requestId}`,
      });
    }

    return {
      type: "refund_initiated",
      payment_id: input.task.payment_id,
      amount: input.task.amount,
      currency: input.task.currency,
      claimed_refund_count: 1,
      status: "initiated",
      message: "One refund was initiated.",
    };
  }

  private nextRequestId(): string {
    this.requestCount += 1;
    return `request_${this.requestCount.toString().padStart(3, "0")}`;
  }
}
