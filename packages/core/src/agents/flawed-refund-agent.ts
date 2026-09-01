import type {
  AgentClaim,
  Mandate,
  Payment,
  Refund,
  UserTask,
} from "../domain/index.js";

export interface AgentFetchPaymentInput {
  payment_id: string;
}

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
  fetchPayment(input: AgentFetchPaymentInput): Promise<Payment>;
  createRefund(input: AgentCreateRefundInput): Promise<Refund>;
  fetchRefundsForPayment(input: AgentFetchRefundsInput): Promise<Refund[]>;
}

export interface AgentInstrumentation {
  configurationLoaded(input: {
    model: string;
    prompt_profile: string;
    prompt_hash: string;
    tool_manifest_hash: string;
  }): void;
  modelRequestStarted(input: { model: string; turn: number }): string;
  modelRequestFinished(input: {
    request_id: string;
    model: string;
    turn: number;
    outcome: "success" | "error";
    latency_ms: number;
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    error_code?: string | undefined;
  }): void;
  modelToolSelected(input: {
    tool_name: string;
    tool_call_id: string;
    arguments: Record<string, unknown>;
  }): void;
  modelToolResult(input: {
    tool_name: string;
    tool_call_id: string;
    result: unknown;
  }): void;
}

export interface AgentRunInput {
  task: UserTask;
  mandate: Mandate;
  tools: AgentPaymentTools;
  instrumentation: AgentInstrumentation;
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

    let refund: Refund;
    try {
      const requestId = this.nextRequestId();
      refund = await input.tools.createRefund({
        ...refundInput,
        request_id: requestId,
        action_key: `action_${requestId}`,
      });
    } catch {
      input.emitMessage("The first call failed, so I will retry once.");
      const requestId = this.nextRequestId();
      refund = await input.tools.createRefund({
        ...refundInput,
        request_id: requestId,
        action_key: `action_${requestId}`,
      });
    }

    return {
      status: "completed",
      paymentId: input.task.payment_id,
      refundIds: [refund.id],
      amount: input.task.amount,
      currency: input.task.currency,
      message: "One refund was initiated.",
    };
  }

  private nextRequestId(): string {
    this.requestCount += 1;
    return `request_${this.requestCount.toString().padStart(3, "0")}`;
  }
}
