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

export class PaymentWorldError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PaymentWorldError";
    this.code = code;
  }
}

export class AmbiguousResultError extends Error {
  readonly code = "AMBIGUOUS_TIMEOUT";
  readonly ambiguous = true;

  constructor(
    message: string,
    readonly refundId?: string,
  ) {
    super(message);
    this.name = "AmbiguousResultError";
  }
}

export { AmbiguousResultError as AmbiguousPaymentError };

export interface PaymentWorldDependencies {
  payments: Payment[];
  faults: FaultSpec[];
  ids: DeterministicIdGenerator;
  clock: Clock;
  trace: TraceRecorder;
}

export class PaymentWorld implements PaymentProvider {
  private readonly payments = new Map<string, Payment>();
  private readonly refunds: Refund[] = [];
  private readonly operationOccurrences = new Map<string, number>();

  constructor(private readonly dependencies: PaymentWorldDependencies) {
    for (const payment of dependencies.payments) {
      this.payments.set(payment.id, structuredClone(payment));
    }
  }

  async fetchPayment(input: FetchPaymentInput): Promise<Payment> {
    const payment = this.payments.get(input.payment_id);
    if (!payment) {
      throw new PaymentWorldError(
        "PAYMENT_NOT_FOUND",
        `Payment ${input.payment_id} does not exist`,
      );
    }
    return structuredClone(payment);
  }

  async createRefund(input: CreateRefundInput): Promise<Refund> {
    const payment = this.payments.get(input.payment_id);
    if (!payment) {
      throw new PaymentWorldError(
        "PAYMENT_NOT_FOUND",
        `Payment ${input.payment_id} does not exist`,
      );
    }
    if (payment.status !== "captured") {
      throw new PaymentWorldError(
        "PAYMENT_NOT_CAPTURED",
        `Payment ${payment.id} is not captured`,
      );
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new PaymentWorldError(
        "INVALID_REFUND_AMOUNT",
        "Refund amount must be a positive integer in minor units",
      );
    }
    if (input.currency !== payment.currency) {
      throw new PaymentWorldError(
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
        throw new PaymentWorldError(
          "ACTION_KEY_CONFLICT",
          "The action key was already used for a different refund intention",
        );
      }
      this.dependencies.trace.append(
        "payment.refund.deduplicated",
        {
          refund: structuredClone(existingRefund),
          action_key: input.action_key,
        },
        input.call_id,
      );
      return structuredClone(existingRefund);
    }

    if (payment.refunded_amount + input.amount > payment.amount) {
      throw new PaymentWorldError(
        "REFUND_EXCEEDS_CAPTURED_AMOUNT",
        "Refund would exceed the captured payment amount",
      );
    }

    const occurrence = this.nextOccurrence("create_refund");
    const beforeSideEffectFault = this.dependencies.faults.find(
      (candidate) =>
        candidate.operation === "create_refund" &&
        candidate.type === "timeout_before_side_effect" &&
        candidate.occurrence === occurrence,
    );
    if (beforeSideEffectFault) {
      this.dependencies.trace.append(
        "fault.injected",
        {
          fault: beforeSideEffectFault,
          operation: "create_refund",
          call_id: input.call_id,
        },
        input.call_id,
      );
      throw new AmbiguousResultError(
        "The request timed out before the refund committed",
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
    this.dependencies.trace.append(
      "payment.refund.created",
      {
        refund: structuredClone(refund),
        payment_refunded_amount: payment.refunded_amount,
      },
      input.call_id,
    );

    const fault = this.dependencies.faults.find(
      (candidate) =>
        candidate.operation === "create_refund" &&
        candidate.type === "timeout_after_side_effect" &&
        candidate.occurrence === occurrence,
    );
    if (fault) {
      this.dependencies.trace.append(
        "fault.injected",
        {
          fault,
          operation: "create_refund",
          call_id: input.call_id,
          refund_id: refund.id,
        },
        input.call_id,
      );
      throw new AmbiguousResultError(
        "The refund committed, but the response timed out",
        refund.id,
      );
    }

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

  private nextOccurrence(operation: string): number {
    const occurrence = (this.operationOccurrences.get(operation) ?? 0) + 1;
    this.operationOccurrences.set(operation, occurrence);
    return occurrence;
  }
}
