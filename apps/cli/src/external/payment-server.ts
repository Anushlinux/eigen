import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  type AgentRunInput,
  AmbiguousResultError,
  createRefundFingerprint,
  PaymentProviderError,
} from "@eigen/core";
import { z } from "zod";

const refundBody = z
  .object({
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    case_id: z.string().min(1).max(200),
  })
  .strict();

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) throw new Error("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function startPaymentServer(input: AgentRunInput, token: string) {
  let stopped = false;
  let unkeyedRequests = 0;
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent)
        json(response, 400, { error: "INVALID_PAYMENT_REQUEST" });
      else response.destroy();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (stopped || request.headers["x-eigen-token"] !== token) {
      json(response, 403, { error: "PAYMENT_SESSION_CLOSED_OR_INVALID" });
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const match = path.match(
      /^\/v1\/payments\/([^/]+)(?:\/(refund|refunds))?$/,
    );
    if (!match?.[1]) {
      json(response, 404, { error: "NOT_FOUND" });
      return;
    }
    const paymentId = decodeURIComponent(match[1]);
    try {
      if (request.method === "GET" && !match[2]) {
        json(
          response,
          200,
          await input.tools.fetchPayment({ payment_id: paymentId }),
        );
        return;
      }
      if (request.method === "GET" && match[2] === "refunds") {
        const refunds = await input.tools.fetchRefundsForPayment({
          payment_id: paymentId,
          semantic_action_key: createRefundFingerprint({
            mandate_id: input.mandate.id,
            action: "create_refund",
            payment_id: input.task.payment_id,
            amount: input.task.amount,
            currency: input.task.currency,
            purpose: input.task.purpose,
          }),
        });
        json(response, 200, { items: refunds.map(publicRefund) });
        return;
      }
      if (request.method !== "POST" || match[2] !== "refund") {
        json(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return;
      }
      const body = refundBody.parse(await jsonBody(request));
      const requestId = z
        .string()
        .min(1)
        .max(200)
        .parse(request.headers["x-request-id"]);
      const suppliedKey = request.headers["x-refund-idempotency"];
      const key =
        suppliedKey === undefined
          ? `unkeyed:${++unkeyedRequests}`
          : z.string().min(1).max(200).parse(suppliedKey);
      // No policy enforcement, reconciliation, or stable-key repair here.
      const refund = await input.tools.createRefund({
        payment_id: paymentId,
        amount: body.amount,
        currency: body.currency,
        purpose: body.case_id,
        request_id: requestId,
        action_key: key,
      });
      json(response, 200, publicRefund(refund));
    } catch (error) {
      if (error instanceof AmbiguousResultError) {
        // Both injected faults look identical to the application. No refund ID
        // or side-effect hint leaves the server on the lost-response path.
        response.destroy();
      } else if (error instanceof PaymentProviderError) {
        json(response, 422, { error: error.code });
      } else {
        throw error;
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Payment server failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      stopped = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function publicRefund(refund: {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: string;
}) {
  return {
    id: refund.id,
    payment_id: refund.payment_id,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status,
  };
}
