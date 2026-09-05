import {
  AmbiguousResultError,
  type CreateRefundInput,
  type FetchPaymentInput,
  type FetchRefundsInput,
  type Payment,
  type PaymentProvider,
  PaymentProviderError,
  type Refund,
} from "@eigen/core";
import { z } from "zod";
import {
  FetchRazorpayTransport,
  type RazorpayHttpRequest,
  type RazorpayHttpResponse,
  type RazorpayHttpTransport,
} from "./transport.js";

const identifier = z.string().trim().min(1);
const currency = z.string().regex(/^[A-Z]{3}$/);
const paymentSchema = z.object({
  id: identifier,
  amount: z.number().int().positive(),
  currency,
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  amount_refunded: z.number().int().nonnegative(),
});
const notesSchema = z.union([
  z.record(z.string(), z.union([z.string(), z.number()])),
  z.array(z.unknown()),
]);
const refundSchema = z.object({
  id: identifier,
  amount: z.number().int().positive(),
  currency,
  payment_id: identifier,
  status: z.enum(["pending", "processed", "failed"]),
  created_at: z.number().int().nonnegative(),
  receipt: z.string().nullable().optional(),
  notes: notesSchema.optional().default({}),
});
const refundCollectionSchema = z.object({
  entity: z.literal("collection"),
  count: z.number().int().nonnegative(),
  items: z.array(refundSchema),
});
const errorSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
});

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{10,}$/;
const NOTE_KEYS = {
  runId: "eigen_run_id",
  mandateId: "eigen_mandate_id",
  actionKey: "eigen_action_key",
  fingerprint: "eigen_fingerprint",
  purpose: "eigen_purpose",
} as const;

export interface RazorpayEnvironment {
  RAZORPAY_KEY_ID?: string | undefined;
  RAZORPAY_KEY_SECRET?: string | undefined;
  RAZORPAY_TEST_PAYMENT_ID?: string | undefined;
  EIGEN_ALLOW_RAZORPAY_TEST_WRITES?: string | undefined;
}

export interface RazorpayConfiguration {
  keyId: string;
  keySecret: string;
}

export function validateRazorpayEnvironment(
  environment: RazorpayEnvironment,
): RazorpayConfiguration {
  const keyId = environment.RAZORPAY_KEY_ID?.trim();
  const keySecret = environment.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId) {
    throw new PaymentProviderError(
      "RAZORPAY_KEY_ID_MISSING",
      "RAZORPAY_KEY_ID is required.",
      "authentication",
    );
  }
  if (keyId.startsWith("rzp_live_")) {
    throw new PaymentProviderError(
      "LIVE_RAZORPAY_CREDENTIAL_REJECTED",
      "Live Razorpay credentials are not accepted.",
      "authentication",
    );
  }
  if (!keyId.startsWith("rzp_test_")) {
    throw new PaymentProviderError(
      "RAZORPAY_TEST_KEY_REQUIRED",
      "RAZORPAY_KEY_ID must use the rzp_test_ prefix.",
      "authentication",
    );
  }
  if (!keySecret) {
    throw new PaymentProviderError(
      "RAZORPAY_KEY_SECRET_MISSING",
      "RAZORPAY_KEY_SECRET is required.",
      "authentication",
    );
  }
  return { keyId, keySecret };
}

export interface RazorpayExchangeMetadata {
  method: "GET" | "POST";
  path: string;
  request: {
    authorization: "[REDACTED]";
    idempotency_key: "[PRESENT]" | "[NOT_PRESENT]";
    amount?: number | undefined;
    note_keys?: string[] | undefined;
  };
  response: {
    status: number | null;
    entity?: string | undefined;
    resource_id?: string | undefined;
    item_count?: number | undefined;
    error_code?: string | undefined;
    outcome: "success" | "error" | "transport_error";
  };
}

export interface RazorpayTestAdapterOptions extends RazorpayConfiguration {
  runId: string;
  transport?: RazorpayHttpTransport | undefined;
  recordExchange?(metadata: RazorpayExchangeMetadata): void;
}

function normalizedNotes(
  value: z.infer<typeof notesSchema>,
): Record<string, string> {
  if (Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, String(entry)]),
  );
}

function summarizeBody(body: unknown): RazorpayExchangeMetadata["response"] {
  if (!body || typeof body !== "object") {
    return { status: null, outcome: "error" };
  }
  const record = body as Record<string, unknown>;
  const error =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
  return {
    status: null,
    ...(typeof record.entity === "string" ? { entity: record.entity } : {}),
    ...(typeof record.id === "string" ? { resource_id: record.id } : {}),
    ...(Array.isArray(record.items) ? { item_count: record.items.length } : {}),
    ...(typeof error?.code === "string" ? { error_code: error.code } : {}),
    outcome: "success",
  };
}

function mapProviderError(
  response: RazorpayHttpResponse,
): PaymentProviderError {
  const parsed = errorSchema.safeParse(response.body);
  const providerCode = parsed.success ? parsed.data.error?.code : undefined;
  if (response.status === 401 || response.status === 403) {
    return new PaymentProviderError(
      "RAZORPAY_AUTHENTICATION_FAILED",
      "Razorpay rejected the Test Mode credentials.",
      "authentication",
      false,
      response.status,
    );
  }
  if (response.status === 409) {
    return new PaymentProviderError(
      "RAZORPAY_CONFLICT",
      "Razorpay reported a concurrent or idempotency conflict.",
      "conflict",
      true,
      response.status,
    );
  }
  if (response.status === 429) {
    return new PaymentProviderError(
      "RAZORPAY_RATE_LIMITED",
      "Razorpay rate-limited the request.",
      "rate_limit",
      true,
      response.status,
    );
  }
  if (response.status >= 500) {
    return new PaymentProviderError(
      "RAZORPAY_UNAVAILABLE",
      "Razorpay could not complete the request.",
      "unavailable",
      true,
      response.status,
    );
  }
  return new PaymentProviderError(
    providerCode === "BAD_REQUEST_ERROR"
      ? "RAZORPAY_BAD_REQUEST"
      : "RAZORPAY_REMOTE_ERROR",
    "Razorpay rejected the payment operation.",
    "remote_response",
    false,
    response.status,
  );
}

export class RazorpayTestAdapter implements PaymentProvider {
  private readonly transport: RazorpayHttpTransport;

  constructor(private readonly options: RazorpayTestAdapterOptions) {
    if (!options.keyId.startsWith("rzp_test_")) {
      throw new PaymentProviderError(
        options.keyId.startsWith("rzp_live_")
          ? "LIVE_RAZORPAY_CREDENTIAL_REJECTED"
          : "RAZORPAY_TEST_KEY_REQUIRED",
        "Only Razorpay Test Mode credentials are accepted.",
        "authentication",
      );
    }
    if (!options.keySecret.trim()) {
      throw new PaymentProviderError(
        "RAZORPAY_KEY_SECRET_MISSING",
        "RAZORPAY_KEY_SECRET is required.",
        "authentication",
      );
    }
    this.transport = options.transport ?? new FetchRazorpayTransport();
  }

  async fetchPayment(input: FetchPaymentInput): Promise<Payment> {
    const response = await this.request({
      method: "GET",
      path: `/v1/payments/${encodeURIComponent(input.payment_id)}`,
      headers: { "Content-Type": "application/json" },
    });
    const parsed = paymentSchema.safeParse(response.body);
    if (!parsed.success) throw this.invalidResponse();
    return {
      id: parsed.data.id,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      status: parsed.data.status,
      refunded_amount: parsed.data.amount_refunded,
    };
  }

  async createRefund(input: CreateRefundInput): Promise<Refund> {
    this.validateCreateInput(input);
    const existingRefunds = await this.fetchRefundsForPayment({
      payment_id: input.payment_id,
    });
    const existing = existingRefunds.find(
      (refund) => refund.action_key === input.action_key,
    );
    if (existing) {
      if (
        existing.payment_id !== input.payment_id ||
        existing.amount !== input.amount ||
        existing.currency !== input.currency ||
        existing.mandate_id !== input.mandate.id ||
        existing.purpose !== input.purpose
      ) {
        throw new PaymentProviderError(
          "ACTION_KEY_CONFLICT",
          "The action key belongs to a different Razorpay refund intention.",
          "conflict",
        );
      }
      return existing;
    }

    const payment = await this.fetchPayment({ payment_id: input.payment_id });
    if (payment.status !== "captured") {
      throw new PaymentProviderError(
        "PAYMENT_NOT_CAPTURED",
        "The Razorpay payment is not captured.",
      );
    }
    if (payment.currency !== input.currency) {
      throw new PaymentProviderError(
        "CURRENCY_MISMATCH",
        "The refund currency does not match the Razorpay payment.",
      );
    }
    if (payment.refunded_amount + input.amount > payment.amount) {
      throw new PaymentProviderError(
        "REFUND_EXCEEDS_CAPTURED_AMOUNT",
        "The refund exceeds the remaining refundable amount.",
      );
    }

    const response = await this.request(
      {
        method: "POST",
        path: `/v1/payments/${encodeURIComponent(input.payment_id)}/refund`,
        headers: {
          "Content-Type": "application/json",
          "X-Refund-Idempotency": input.action_key,
        },
        body: {
          amount: input.amount,
          speed: "normal",
          notes: {
            [NOTE_KEYS.runId]: this.options.runId,
            [NOTE_KEYS.mandateId]: input.mandate.id,
            [NOTE_KEYS.actionKey]: input.action_key,
            [NOTE_KEYS.fingerprint]: input.action_key,
            [NOTE_KEYS.purpose]: input.purpose,
          },
        },
      },
      true,
    );
    return this.mapRefund(response.body);
  }

  async fetchRefundsForPayment(input: FetchRefundsInput): Promise<Refund[]> {
    const refunds: Refund[] = [];
    let skip = 0;
    while (true) {
      const response = await this.request({
        method: "GET",
        path: `/v1/payments/${encodeURIComponent(input.payment_id)}/refunds?count=100&skip=${skip}`,
        headers: { "Content-Type": "application/json" },
      });
      const parsed = refundCollectionSchema.safeParse(response.body);
      if (!parsed.success) throw this.invalidResponse();
      refunds.push(...parsed.data.items.map((item) => this.mapRefund(item)));
      if (parsed.data.items.length < 100) break;
      skip += parsed.data.items.length;
    }
    return refunds;
  }

  private validateCreateInput(input: CreateRefundInput): void {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new PaymentProviderError(
        "INVALID_REFUND_AMOUNT",
        "Refund amount must be a positive integer in minor units.",
      );
    }
    if (!IDEMPOTENCY_KEY.test(input.action_key)) {
      throw new PaymentProviderError(
        "INVALID_IDEMPOTENCY_KEY",
        "Refund idempotency keys must be at least 10 allowed characters.",
      );
    }
    if (input.purpose.length > 512) {
      throw new PaymentProviderError(
        "REFUND_PURPOSE_TOO_LONG",
        "Refund purpose exceeds the Razorpay notes limit.",
      );
    }
  }

  private mapRefund(value: unknown): Refund {
    const parsed = refundSchema.safeParse(value);
    if (!parsed.success) throw this.invalidResponse();
    const notes = normalizedNotes(parsed.data.notes);
    const external = `external:${parsed.data.id}`;
    return {
      id: parsed.data.id,
      payment_id: parsed.data.payment_id,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      status: parsed.data.status,
      request_id: parsed.data.receipt ?? parsed.data.id,
      action_key: notes[NOTE_KEYS.actionKey] ?? external,
      mandate_id: notes[NOTE_KEYS.mandateId] ?? external,
      purpose: notes[NOTE_KEYS.purpose] ?? external,
      semantic_fingerprint: notes[NOTE_KEYS.fingerprint] ?? external,
      created_at: new Date(parsed.data.created_at * 1000).toISOString(),
    };
  }

  private async request(
    input: Omit<RazorpayHttpRequest, "credentials">,
    ambiguousWrite = false,
  ): Promise<RazorpayHttpResponse> {
    const requestMetadata: RazorpayExchangeMetadata["request"] = {
      authorization: "[REDACTED]",
      idempotency_key:
        input.headers["X-Refund-Idempotency"] === undefined
          ? "[NOT_PRESENT]"
          : "[PRESENT]",
      ...(input.body &&
      typeof input.body === "object" &&
      "amount" in input.body &&
      typeof input.body.amount === "number"
        ? { amount: input.body.amount }
        : {}),
      ...(input.body &&
      typeof input.body === "object" &&
      "notes" in input.body &&
      input.body.notes &&
      typeof input.body.notes === "object"
        ? { note_keys: Object.keys(input.body.notes) }
        : {}),
    };
    try {
      const response = await this.transport.request({
        ...input,
        credentials: {
          keyId: this.options.keyId,
          keySecret: this.options.keySecret,
        },
      });
      const summary = summarizeBody(response.body);
      this.options.recordExchange?.({
        method: input.method,
        path: input.path,
        request: requestMetadata,
        response: {
          ...summary,
          status: response.status,
          outcome:
            response.status >= 200 && response.status < 300
              ? "success"
              : "error",
        },
      });
      if (response.status < 200 || response.status >= 300) {
        throw mapProviderError(response);
      }
      return response;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;
      this.options.recordExchange?.({
        method: input.method,
        path: input.path,
        request: requestMetadata,
        response: { status: null, outcome: "transport_error" },
      });
      if (ambiguousWrite) throw new AmbiguousResultError();
      throw new PaymentProviderError(
        "RAZORPAY_UNAVAILABLE",
        "Razorpay could not be reached.",
        "unavailable",
        true,
      );
    }
  }

  private invalidResponse(): PaymentProviderError {
    return new PaymentProviderError(
      "INVALID_RAZORPAY_RESPONSE",
      "Razorpay returned an invalid response shape.",
      "remote_response",
    );
  }
}
