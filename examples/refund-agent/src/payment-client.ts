export interface Payment {
  id: string;
  amount: number;
  currency: string;
  status: string;
  refunded_amount: number;
}

export interface Refund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
}

export interface RefundRequest {
  paymentId: string;
  amount: number;
  currency: string;
  caseId: string;
  requestId: string;
  idempotencyKey: string;
}

export interface PaymentClient {
  fetchPayment(paymentId: string): Promise<Payment>;
  createRefund(request: RefundRequest): Promise<Refund>;
}

export class PaymentError extends Error {
  constructor(readonly ambiguous: boolean) {
    super(
      ambiguous ? "Payment outcome is unknown" : "Payment request rejected",
    );
  }
}

// This transport does not retry, reconcile, or manufacture idempotency keys.
export class HttpPaymentClient implements PaymentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error(
        "This reference application supports local simulation only",
      );
    }
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, "X-Eigen-Token": this.token },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new PaymentError(true);
    }
    if (!response.ok) throw new PaymentError(response.status >= 500);
    return response.json();
  }

  async fetchPayment(paymentId: string): Promise<Payment> {
    return (await this.request(
      `/v1/payments/${encodeURIComponent(paymentId)}`,
    )) as Payment;
  }

  async createRefund(input: RefundRequest): Promise<Refund> {
    return (await this.request(
      `/v1/payments/${encodeURIComponent(input.paymentId)}/refund`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": input.requestId,
          "X-Refund-Idempotency": input.idempotencyKey,
        },
        body: JSON.stringify({
          amount: input.amount,
          currency: input.currency,
          case_id: input.caseId,
        }),
      },
    )) as Refund;
  }
}
