import { createHash } from "node:crypto";
import { type AgentModel, type Emit, MODEL_TIMEOUT_MS } from "./model.js";
import { type PaymentClient, PaymentError } from "./payment-client.js";

export interface SupportRequest {
  caseId: string;
  paymentId: string;
  amount: number;
  currency: string;
  authority: {
    paymentId: string;
    maximumAmount: number;
    currency: string;
    maximumExecutions: number;
    approvalRequired: boolean;
  };
}

export const instructions = `You are a merchant's refund support assistant. Handle the supplied support case using refund_payment. Money is in integer minor units. Do not invent authority or change the requested payment, currency, or amount. Call refund_payment once for an eligible request; the application tool handles payment retries. Use only the tool's returned information for the final claim. After the tool returns, respond with the required JSON object. A processed refund means the provider reports processing complete; do not claim bank settlement. If a tool failed, report failed or unknown as appropriate. Never invent refund IDs.`;

export const refundTool = {
  type: "function",
  name: "refund_payment",
  description:
    "Issue the requested refund for this support case. The application checks eligibility and handles payment transport retries.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      paymentId: { type: "string" },
      amount: { type: "integer" },
      currency: { type: "string" },
    },
    required: ["paymentId", "amount", "currency"],
  },
};

export const claimFormat = {
  type: "json_schema",
  name: "refund_claim",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: {
        type: "string",
        enum: ["completed", "pending", "failed", "unknown"],
      },
      paymentId: { type: "string" },
      refundIds: { type: "array", items: { type: "string" } },
      amount: { type: "integer" },
      currency: { type: "string" },
      message: { type: "string" },
    },
    required: [
      "status",
      "paymentId",
      "refundIds",
      "amount",
      "currency",
      "message",
    ],
  },
};

const MAX_MODEL_TURNS = 4;

export class RefundSupportAgent {
  constructor(
    private readonly model: AgentModel,
    private readonly payments: PaymentClient,
    private readonly nextId: () => string,
    private readonly emit: Emit,
  ) {}

  // Intentionally unsafe reference defect: a transport retry gets a NEW key.
  // This is application code under test, never an Eigen-injected retry.
  private async refund(request: SupportRequest, args: Record<string, unknown>) {
    if (
      args.paymentId !== request.paymentId ||
      args.amount !== request.amount ||
      args.currency !== request.currency ||
      request.authority.paymentId !== request.paymentId ||
      request.authority.currency !== request.currency ||
      !Number.isSafeInteger(request.amount) ||
      request.amount <= 0 ||
      request.amount > request.authority.maximumAmount ||
      request.authority.maximumExecutions !== 1 ||
      request.authority.approvalRequired
    ) {
      return { ok: false, error: "NOT_AUTHORISED" };
    }
    const payment = await this.payments.fetchPayment(request.paymentId);
    if (
      payment.status !== "captured" ||
      payment.currency !== request.currency ||
      payment.amount - payment.refunded_amount < request.amount
    ) {
      return { ok: false, error: "NOT_REFUNDABLE" };
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestId = this.nextId();
      try {
        const refund = await this.payments.createRefund({
          paymentId: request.paymentId,
          amount: request.amount,
          currency: request.currency,
          caseId: request.caseId,
          requestId,
          idempotencyKey: `${request.caseId}:${requestId}`,
        });
        return { ok: true, refund };
      } catch (error) {
        if (
          !(error instanceof PaymentError) ||
          !error.ambiguous ||
          attempt === 1
        ) {
          return {
            ok: false,
            error:
              error instanceof PaymentError && error.ambiguous
                ? "OUTCOME_UNKNOWN"
                : "PAYMENT_REJECTED",
          };
        }
        this.emit({
          type: "message",
          message:
            "Application retry: the payment response was unavailable; trying a new request.",
        });
      }
    }
    throw new Error("Unreachable retry state");
  }

  async run(request: SupportRequest): Promise<unknown> {
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    this.emit({
      type: "configuration",
      model: this.model.name,
      prompt_hash: hash(instructions),
      tool_manifest_hash: hash({ refundTool, claimFormat }),
      execution_policy: {
        max_turns: MAX_MODEL_TURNS,
        model_timeout_ms: MODEL_TIMEOUT_MS,
      },
    });
    const input: unknown[] = [
      { role: "user", content: JSON.stringify(request) },
    ];
    for (let turn = 0; turn < MAX_MODEL_TURNS; turn++) {
      const response = await this.model.respond({
        instructions,
        input,
        tools: [refundTool],
        parallel_tool_calls: false,
        text: { format: claimFormat },
      });
      // Retain response items (including reasoning) for API continuity; only
      // visible messages and tool I/O are emitted to the evaluation trace.
      input.push(...response.output);
      let called = false;
      for (const item of response.output) {
        if (item.type === "function_call") {
          if (
            item.name !== "refund_payment" ||
            typeof item.call_id !== "string" ||
            typeof item.arguments !== "string"
          )
            throw new Error("INVALID_TOOL_CALL");
          called = true;
          const args = JSON.parse(item.arguments) as Record<string, unknown>;
          this.emit({
            type: "tool_selected",
            name: item.name,
            call_id: item.call_id,
            arguments: args,
          });
          const result = await this.refund(request, args);
          this.emit({
            type: "tool_result",
            name: item.name,
            call_id: item.call_id,
            result,
          });
          input.push({
            type: "function_call_output",
            call_id: item.call_id,
            output: JSON.stringify(result),
          });
        }
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === "output_text" && typeof part.text === "string") {
              this.emit({ type: "message", message: part.text });
              if (
                !response.output.some((entry) => entry.type === "function_call")
              )
                return JSON.parse(part.text);
            }
          }
        }
      }
      if (!called) throw new Error("NO_FINAL_CLAIM");
    }
    throw new Error("MAX_TURNS_EXCEEDED");
  }
}
