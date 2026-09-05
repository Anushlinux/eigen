import {
  type Clock,
  createRefundFingerprint,
  type DeterministicIdGenerator,
  type FaultSpec,
  type Mandate,
  type Payment,
  type Refund,
  type TraceRecorder,
  type WorldSnapshot,
} from "../domain/index.js";

export interface FetchPaymentInput {
  payment_id: string;
}

export interface CreateRefundInput {
  payment_id: string;
  amount: number;
  currency: string;
  purpose: string;
  request_id: string;
  action_key: string;
  call_id: string;
  mandate: Mandate;
}

export interface FetchRefundsInput {
  payment_id: string;
}

export interface PaymentProvider {
  fetchPayment(input: FetchPaymentInput): Promise<Payment>;
  createRefund(input: CreateRefundInput): Promise<Refund>;
  fetchRefundsForPayment(input: FetchRefundsInput): Promise<Refund[]>;
}

export type PaymentProviderErrorCategory =
  | "validation"
  | "authentication"
  | "rate_limit"
  | "conflict"
  | "remote_response"
  | "unavailable";

export class PaymentProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly category: PaymentProviderErrorCategory = "validation",
    readonly retryable = false,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

export { PaymentProviderError as PaymentWorldError };

export class AmbiguousResultError extends Error {
  readonly code = "AMBIGUOUS_RESULT";
  readonly ambiguous = true;

  constructor(message = "The financial outcome is unknown.") {
    super(message);
    this.name = "AmbiguousResultError";
  }
}

export { AmbiguousResultError as AmbiguousPaymentError };

export interface PaymentWorldDependencies {
  payments: Payment[];
  ids: DeterministicIdGenerator;
  clock: Clock;
}

export class PaymentWorld implements PaymentProvider {
  private readonly payments = new Map<string, Payment>();
  private readonly refunds: Refund[] = [];

  constructor(private readonly dependencies: PaymentWorldDependencies) {
    for (const payment of dependencies.payments) {
      this.payments.set(payment.id, structuredClone(payment));
    }
  }

  async fetchPayment(input: FetchPaymentInput): Promise<Payment> {
    const payment = this.payments.get(input.payment_id);
    if (!payment) {
      throw new PaymentProviderError(
        "PAYMENT_NOT_FOUND",
        `Payment ${input.payment_id} does not exist`,
      );
    }
    return structuredClone(payment);
  }

  async createRefund(input: CreateRefundInput): Promise<Refund> {
    const payment = this.payments.get(input.payment_id);
    if (!payment) {
      throw new PaymentProviderError(
        "PAYMENT_NOT_FOUND",
        `Payment ${input.payment_id} does not exist`,
      );
    }
    if (payment.status !== "captured") {
      throw new PaymentProviderError(
        "PAYMENT_NOT_CAPTURED",
        `Payment ${payment.id} is not captured`,
      );
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new PaymentProviderError(
        "INVALID_REFUND_AMOUNT",
        "Refund amount must be a positive integer in minor units",
      );
    }
    if (input.currency !== payment.currency) {
      throw new PaymentProviderError(
        "CURRENCY_MISMATCH",
        `Refund currency ${input.currency} does not match ${payment.currency}`,
      );
    }

    const existingRefund = this.refunds.find(
      (refund) => refund.action_key === input.action_key,
    );
    if (existingRefund) {
      const sameAction =
        existingRefund.payment_id === input.payment_id &&
        existingRefund.amount === input.amount &&
        existingRefund.currency === input.currency &&
        existingRefund.purpose === input.purpose &&
        existingRefund.mandate_id === input.mandate.id;
      if (!sameAction) {
        throw new PaymentProviderError(
          "ACTION_KEY_CONFLICT",
          "The action key was already used for a different refund intention",
          "conflict",
        );
      }
      return structuredClone(existingRefund);
    }

    if (payment.refunded_amount + input.amount > payment.amount) {
      throw new PaymentProviderError(
        "REFUND_EXCEEDS_CAPTURED_AMOUNT",
        "Refund would exceed the captured payment amount",
      );
    }

    const refund: Refund = {
      id: this.dependencies.ids.next("refund"),
      payment_id: payment.id,
      amount: input.amount,
      currency: input.currency,
      status: "processed",
      request_id: input.request_id,
      action_key: input.action_key,
      mandate_id: input.mandate.id,
      purpose: input.purpose,
      semantic_fingerprint: createRefundFingerprint({
        mandate_id: input.mandate.id,
        action: "create_refund",
        payment_id: payment.id,
        amount: input.amount,
        currency: input.currency,
        purpose: input.purpose,
      }),
      created_at: this.dependencies.clock.now(),
    };

    payment.refunded_amount += refund.amount;
    this.refunds.push(refund);
    return structuredClone(refund);
  }

  async fetchRefundsForPayment(input: FetchRefundsInput): Promise<Refund[]> {
    return structuredClone(
      this.refunds.filter((refund) => refund.payment_id === input.payment_id),
    );
  }

  snapshot(): WorldSnapshot {
    return structuredClone({
      payments: [...this.payments.values()],
      refunds: this.refunds,
    });
  }
}

export interface FaultInjectingPaymentProviderDependencies {
  provider: PaymentProvider;
  faults: FaultSpec[];
  trace: TraceRecorder;
  initialWorld: WorldSnapshot;
}

export class FaultInjectingPaymentProvider implements PaymentProvider {
  private readonly operationOccurrences = new Map<string, number>();
  private readonly knownRefundIds = new Set<string>();
  private readonly refundedAmounts = new Map<string, number>();

  constructor(
    private readonly dependencies: FaultInjectingPaymentProviderDependencies,
  ) {
    for (const refund of dependencies.initialWorld.refunds) {
      this.knownRefundIds.add(refund.id);
    }
    for (const payment of dependencies.initialWorld.payments) {
      this.refundedAmounts.set(payment.id, payment.refunded_amount);
    }
  }

  fetchPayment(input: FetchPaymentInput): Promise<Payment> {
    return this.dependencies.provider.fetchPayment(input);
  }

  async createRefund(input: CreateRefundInput): Promise<Refund> {
    const occurrence = this.nextOccurrence("create_refund");
    const beforeFault = this.findFault(
      "timeout_before_side_effect",
      occurrence,
    );
    if (beforeFault) {
      this.recordFault(beforeFault, input.call_id);
      throw new AmbiguousResultError();
    }

    const refund = await this.dependencies.provider.createRefund(input);
    this.recordRefund(refund, input.call_id);

    const afterFault = this.findFault("timeout_after_side_effect", occurrence);
    if (afterFault) {
      this.recordFault(afterFault, input.call_id, refund.id);
      throw new AmbiguousResultError();
    }
    return refund;
  }

  async fetchRefundsForPayment(input: FetchRefundsInput): Promise<Refund[]> {
    const refunds =
      await this.dependencies.provider.fetchRefundsForPayment(input);
    for (const refund of refunds) {
      if (this.knownRefundIds.has(refund.id)) continue;
      this.knownRefundIds.add(refund.id);
      this.dependencies.trace.append("payment.refund.observed", {
        refund: structuredClone(refund),
        source: "reconciliation",
      });
    }
    return refunds;
  }

  private recordRefund(refund: Refund, callId: string): void {
    if (this.knownRefundIds.has(refund.id)) {
      this.dependencies.trace.append(
        "payment.refund.deduplicated",
        { refund: structuredClone(refund), action_key: refund.action_key },
        callId,
      );
      return;
    }
    this.knownRefundIds.add(refund.id);
    const refundedAmount =
      (this.refundedAmounts.get(refund.payment_id) ?? 0) + refund.amount;
    this.refundedAmounts.set(refund.payment_id, refundedAmount);
    this.dependencies.trace.append(
      "payment.refund.created",
      {
        refund: structuredClone(refund),
        payment_refunded_amount: refundedAmount,
      },
      callId,
    );
  }

  private findFault(
    type: FaultSpec["type"],
    occurrence: number,
  ): FaultSpec | undefined {
    return this.dependencies.faults.find(
      (fault) =>
        fault.operation === "create_refund" &&
        fault.type === type &&
        fault.occurrence === occurrence,
    );
  }

  private recordFault(
    fault: FaultSpec,
    callId: string,
    refundId?: string,
  ): void {
    this.dependencies.trace.append(
      "fault.injected",
      {
        fault,
        operation: "create_refund",
        call_id: callId,
        ...(refundId === undefined ? {} : { refund_id: refundId }),
      },
      callId,
    );
  }

  private nextOccurrence(operation: string): number {
    const occurrence = (this.operationOccurrences.get(operation) ?? 0) + 1;
    this.operationOccurrences.set(operation, occurrence);
    return occurrence;
  }
}
