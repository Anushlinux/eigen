import { createHash } from "node:crypto";
import type {
  AgentAdapter,
  AgentInstrumentation,
  AgentRunInput,
  MonotonicTimer,
  Payment,
  Refund,
} from "@eigen/core";
import {
  AmbiguousResultError,
  createRefundFingerprint,
  PaymentProviderError,
  SystemMonotonicTimer,
} from "@eigen/core";
import {
  Agent,
  MaxTurnsExceededError,
  type Model,
  ModelBehaviorError,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  OpenAIProvider,
  Runner,
  type StreamEvent,
  tool,
} from "@openai/agents";
import { z } from "zod";
import {
  isOpenAIRefundProfileId,
  OPENAI_REFUND_PROFILES,
  type OpenAIRefundProfileId,
} from "./profiles.js";

const identifierSchema = z.string().trim().min(1);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const openAIRefundClaimSchema = z
  .object({
    status: z.enum(["completed", "pending", "failed", "unknown"]),
    paymentId: identifierSchema,
    refundIds: z.array(identifierSchema),
    amount: z.number().int().positive(),
    currency: currencySchema,
    message: identifierSchema,
  })
  .strict();

const fetchPaymentInputSchema = z
  .object({ paymentId: identifierSchema })
  .strict();
const createRefundInputSchema = z
  .object({
    mandateId: identifierSchema,
    paymentId: identifierSchema,
    amount: z.number().int().positive(),
    currency: currencySchema,
    purpose: identifierSchema,
    actionKey: identifierSchema,
  })
  .strict();
const fetchRefundsInputSchema = z
  .object({ paymentId: identifierSchema })
  .strict();

const paymentResultSchema = z
  .object({
    id: identifierSchema,
    amount: z.number().int().positive(),
    currency: currencySchema,
    status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
    refundedAmount: z.number().int().nonnegative(),
  })
  .strict();
const refundResultSchema = z
  .object({
    id: identifierSchema,
    paymentId: identifierSchema,
    amount: z.number().int().positive(),
    currency: currencySchema,
    status: z.enum(["pending", "processed", "failed"]),
    actionKey: identifierSchema,
    mandateId: identifierSchema,
    purpose: identifierSchema,
  })
  .strict();
const fetchPaymentOutputSchema = z
  .object({
    ok: z.boolean(),
    payment: paymentResultSchema.optional(),
    errorCode: identifierSchema.optional(),
    message: identifierSchema.optional(),
  })
  .strict();
const createRefundOutputSchema = z
  .object({
    ok: z.boolean(),
    refund: refundResultSchema.optional(),
    errorCode: identifierSchema.optional(),
    message: identifierSchema.optional(),
  })
  .strict();
const fetchRefundsOutputSchema = z
  .object({
    ok: z.boolean(),
    refunds: z.array(refundResultSchema).optional(),
    errorCode: identifierSchema.optional(),
    message: identifierSchema.optional(),
  })
  .strict();

const AMBIGUOUS_RESULT = {
  ok: false as const,
  errorCode: "AMBIGUOUS_RESULT",
  message:
    "The request timed out and may already have completed. The financial outcome is unknown.",
};

const toolDefinitions = [
  {
    name: "fetch_payment",
    description: "Fetch the authoritative state of one payment.",
    input: fetchPaymentInputSchema,
    output: fetchPaymentOutputSchema,
  },
  {
    name: "create_refund",
    description:
      "Create a refund in integer currency minor units for the supplied mandate and action key.",
    input: createRefundInputSchema,
    output: createRefundOutputSchema,
  },
  {
    name: "fetch_refunds_for_payment",
    description: "Fetch all authoritative refunds for one payment.",
    input: fetchRefundsInputSchema,
    output: fetchRefundsOutputSchema,
  },
] as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([first], [second]) => first.localeCompare(second))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function getOpenAIRefundToolManifest() {
  return toolDefinitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    input_schema: z.toJSONSchema(definition.input),
    output_schema: z.toJSONSchema(definition.output),
  }));
}

export function getOpenAIRefundToolManifestHash(): string {
  return hash(getOpenAIRefundToolManifest());
}

export function getOpenAIRefundPromptHash(
  profileId: OpenAIRefundProfileId,
): string {
  return hash(OPENAI_REFUND_PROFILES[profileId].instructions);
}

function modelPayment(payment: Payment) {
  return {
    id: payment.id,
    amount: payment.amount,
    currency: payment.currency,
    status: payment.status,
    refundedAmount: payment.refunded_amount,
  };
}

function modelRefund(refund: Refund) {
  return {
    id: refund.id,
    paymentId: refund.payment_id,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status,
    actionKey: refund.action_key,
    mandateId: refund.mandate_id,
    purpose: refund.purpose,
  };
}

function safeToolError(error: unknown) {
  if (error instanceof AmbiguousResultError) return AMBIGUOUS_RESULT;
  if (error instanceof PaymentProviderError) {
    return {
      ok: false as const,
      errorCode: error.code,
      message: error.message,
    };
  }
  return {
    ok: false as const,
    errorCode: "TOOL_ERROR",
    message: "The payment tool could not complete the request.",
  };
}

function safeModelErrorCode(error: unknown): string {
  if (error instanceof MaxTurnsExceededError) return "MAX_TURNS_EXCEEDED";
  if (error instanceof ModelBehaviorError) return "INVALID_FINAL_OUTPUT";
  return "MODEL_REQUEST_FAILED";
}

export class OpenAIAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OpenAIAdapterError";
  }
}

class RecordingModel implements Model {
  constructor(
    private readonly inner: Model,
    private readonly modelName: string,
    private readonly instrumentation: AgentInstrumentation,
    private readonly timer: MonotonicTimer,
    private readonly nextTurn: () => number,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const turn = this.nextTurn();
    const requestId = this.instrumentation.modelRequestStarted({
      model: this.modelName,
      turn,
    });
    const started = this.timer.now();
    try {
      const response = await this.inner.getResponse(request);
      const usageAvailable =
        response.usage.inputTokens > 0 || response.usage.outputTokens > 0;
      this.instrumentation.modelRequestFinished({
        request_id: requestId,
        model: this.modelName,
        turn,
        outcome: "success",
        latency_ms: Math.max(0, this.timer.now() - started),
        ...(usageAvailable
          ? {
              input_tokens: response.usage.inputTokens,
              output_tokens: response.usage.outputTokens,
            }
          : {}),
      });
      return response;
    } catch (error) {
      this.instrumentation.modelRequestFinished({
        request_id: requestId,
        model: this.modelName,
        turn,
        outcome: "error",
        latency_ms: Math.max(0, this.timer.now() - started),
        error_code: safeModelErrorCode(error),
      });
      throw error;
    }
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.getStreamedResponse(request);
  }

  getRetryAdvice(...args: Parameters<NonNullable<Model["getRetryAdvice"]>>) {
    return this.inner.getRetryAdvice?.(...args);
  }
}

class RecordingModelProvider implements ModelProvider {
  private turn = 0;

  constructor(
    private readonly inner: ModelProvider,
    private readonly instrumentation: AgentInstrumentation,
    private readonly timer: MonotonicTimer,
  ) {}

  async getModel(modelName?: string): Promise<Model> {
    const model = await this.inner.getModel(modelName);
    return new RecordingModel(
      model,
      modelName ?? "unspecified",
      this.instrumentation,
      this.timer,
      () => {
        this.turn += 1;
        return this.turn;
      },
    );
  }
}

function toolCallId(
  details: { toolCall?: { callId: string } } | undefined,
  fallback: () => string,
): string {
  return details?.toolCall?.callId ?? fallback();
}

export interface OpenAIRefundAgentOptions {
  profileId: OpenAIRefundProfileId;
  model: string;
  modelProvider: ModelProvider;
  tracingEnabled?: boolean | undefined;
  maxTurns?: number | undefined;
  timer?: MonotonicTimer | undefined;
}

export class OpenAIRefundAgent implements AgentAdapter {
  readonly id: OpenAIRefundProfileId;
  private readonly timer: MonotonicTimer;
  private fallbackToolCall = 0;

  constructor(private readonly options: OpenAIRefundAgentOptions) {
    this.id = options.profileId;
    this.timer = options.timer ?? new SystemMonotonicTimer();
  }

  async run(input: AgentRunInput) {
    const profile = OPENAI_REFUND_PROFILES[this.options.profileId];
    const promptHash = getOpenAIRefundPromptHash(profile.id);
    const manifestHash = getOpenAIRefundToolManifestHash();
    const semanticFingerprint = createRefundFingerprint({
      mandate_id: input.mandate.id,
      action: "create_refund",
      payment_id: input.task.payment_id,
      amount: input.task.amount,
      currency: input.task.currency,
      purpose: input.task.purpose,
    });
    input.instrumentation.configurationLoaded({
      model: this.options.model,
      prompt_profile: profile.id,
      prompt_hash: promptHash,
      tool_manifest_hash: manifestHash,
    });
    const fallbackId = () => {
      this.fallbackToolCall += 1;
      return `tool_call_${this.fallbackToolCall.toString().padStart(3, "0")}`;
    };
    const record = async <T>(
      name: string,
      args: Record<string, unknown>,
      details: { toolCall?: { callId: string } } | undefined,
      execute: (callId: string) => Promise<T>,
    ): Promise<T> => {
      const callId = toolCallId(details, fallbackId);
      input.instrumentation.modelToolSelected({
        tool_name: name,
        tool_call_id: callId,
        arguments: args,
      });
      const result = await execute(callId);
      input.instrumentation.modelToolResult({
        tool_name: name,
        tool_call_id: callId,
        result,
      });
      return result;
    };

    const fetchPayment = tool({
      name: toolDefinitions[0].name,
      description: toolDefinitions[0].description,
      parameters: fetchPaymentInputSchema,
      outputSchema: fetchPaymentOutputSchema,
      async execute(args, _context, details) {
        return record("fetch_payment", args, details, async () => {
          try {
            const payment = await input.tools.fetchPayment({
              payment_id: args.paymentId,
            });
            return { ok: true as const, payment: modelPayment(payment) };
          } catch (error) {
            return safeToolError(error);
          }
        });
      },
    });
    const createRefund = tool({
      name: toolDefinitions[1].name,
      description: toolDefinitions[1].description,
      parameters: createRefundInputSchema,
      outputSchema: createRefundOutputSchema,
      async execute(args, _context, details) {
        return record("create_refund", args, details, async (callId) => {
          if (args.mandateId !== input.mandate.id) {
            return {
              ok: false as const,
              errorCode: "MANDATE_MISMATCH",
              message: "The supplied mandate does not authorize this request.",
            };
          }
          try {
            const refund = await input.tools.createRefund({
              payment_id: args.paymentId,
              amount: args.amount,
              currency: args.currency,
              purpose: args.purpose,
              request_id: callId,
              action_key: args.actionKey,
            });
            return { ok: true as const, refund: modelRefund(refund) };
          } catch (error) {
            return safeToolError(error);
          }
        });
      },
    });
    const fetchRefunds = tool({
      name: toolDefinitions[2].name,
      description: toolDefinitions[2].description,
      parameters: fetchRefundsInputSchema,
      outputSchema: fetchRefundsOutputSchema,
      async execute(args, _context, details) {
        return record("fetch_refunds_for_payment", args, details, async () => {
          try {
            const refunds = await input.tools.fetchRefundsForPayment({
              payment_id: args.paymentId,
              semantic_action_key: semanticFingerprint,
            });
            return {
              ok: true as const,
              refunds: refunds.map(modelRefund),
            };
          } catch (error) {
            return safeToolError(error);
          }
        });
      },
    });

    const agent = new Agent({
      name: profile.id,
      instructions: profile.instructions,
      model: this.options.model,
      tools: [fetchPayment, createRefund, fetchRefunds],
      outputType: openAIRefundClaimSchema,
    });
    const runner = new Runner({
      modelProvider: new RecordingModelProvider(
        this.options.modelProvider,
        input.instrumentation,
        this.timer,
      ),
      tracingDisabled: !(this.options.tracingEnabled ?? false),
      traceIncludeSensitiveData: false,
      workflowName: "Eigen refund experiment",
    });
    const modelInput = JSON.stringify({
      task: {
        type: input.task.type,
        paymentId: input.task.payment_id,
        amount: input.task.amount,
        currency: input.task.currency,
        purpose: input.task.purpose,
      },
      mandate: {
        id: input.mandate.id,
        action: input.mandate.action,
        resourceId: input.mandate.resource_id,
        maximumAmount: input.mandate.maximum_amount,
        currency: input.mandate.currency,
        maximumExecutions: input.mandate.maximum_executions,
        approvalRequired: input.mandate.approval_required,
        purpose: input.mandate.purpose,
      },
    });
    try {
      const result = await runner.run(agent, modelInput, {
        maxTurns: this.options.maxTurns ?? 10,
      });
      return openAIRefundClaimSchema.parse(result.finalOutput);
    } catch (error) {
      const code = safeModelErrorCode(error);
      throw new OpenAIAdapterError(
        code,
        code === "MAX_TURNS_EXCEEDED"
          ? "The agent exceeded the maximum model turn limit."
          : code === "INVALID_FINAL_OUTPUT"
            ? "The model did not produce a valid structured final output."
            : "The model request failed.",
        { cause: error },
      );
    }
  }
}

export interface OpenAIEnvironment {
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  EIGEN_OPENAI_TRACING?: string | undefined;
}

export function validateOpenAIEnvironment(environment: OpenAIEnvironment): {
  apiKey: string;
  model: string;
  tracingEnabled: boolean;
} {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for a live run");
  if (!model) throw new Error("OPENAI_MODEL is required for a live run");
  return {
    apiKey,
    model,
    tracingEnabled: environment.EIGEN_OPENAI_TRACING === "1",
  };
}

export function createLiveOpenAIRefundAgent(
  profileId: string,
  environment: OpenAIEnvironment = process.env,
): OpenAIRefundAgent {
  if (!isOpenAIRefundProfileId(profileId)) {
    throw new Error(`Unknown OpenAI refund profile: ${profileId}`);
  }
  const configuration = validateOpenAIEnvironment(environment);
  return new OpenAIRefundAgent({
    profileId,
    model: configuration.model,
    modelProvider: new OpenAIProvider({
      apiKey: configuration.apiKey,
      useResponses: true,
    }),
    tracingEnabled: configuration.tracingEnabled,
  });
}
