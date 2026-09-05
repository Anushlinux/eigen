import { createInterface } from "node:readline";
import { RefundSupportAgent, type SupportRequest } from "./agent.js";
import { type Emit, ResponsesModel } from "./model.js";
import { HttpPaymentClient } from "./payment-client.js";

const emit: Emit = (event) =>
  process.stdout.write(`${JSON.stringify(event)}\n`);

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  const modelName = process.env.OPENAI_MODEL;
  const paymentUrl = process.env.EIGEN_PAYMENT_BASE_URL;
  const paymentToken = process.env.EIGEN_PAYMENT_TOKEN;
  if (!apiKey || !modelName || !paymentUrl || !paymentToken)
    throw new Error("MISSING_CONFIGURATION");
  if (process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_SECRET)
    throw new Error("PAYMENT_CREDENTIALS_NOT_ALLOWED");
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const first = await lines[Symbol.asyncIterator]().next();
  lines.close();
  if (first.done) throw new Error("MISSING_SUPPORT_REQUEST");
  let id = 0;
  const agent = new RefundSupportAgent(
    new ResponsesModel(
      modelName,
      apiKey,
      emit,
      () => performance.now(),
      process.env.OPENAI_BASE_URL,
    ),
    new HttpPaymentClient(paymentUrl, paymentToken),
    () => `request_${++id}`,
    emit,
  );
  const claim = await agent.run(JSON.parse(first.value) as SupportRequest);
  emit({ type: "final", claim });
}

main().catch(() => {
  emit({ type: "error", code: "APPLICATION_FAILED" });
  process.exitCode = 1;
});
