import { createHash } from "node:crypto";
import type { Currency } from "./types.js";

export interface RefundFingerprintInput {
  mandate_id: string;
  action: "create_refund";
  payment_id: string;
  amount: number;
  currency: Currency;
  purpose: string;
}

export function createRefundFingerprint(input: RefundFingerprintInput): string {
  const canonicalTuple = [
    input.mandate_id,
    input.action,
    input.payment_id,
    input.amount,
    input.currency,
    input.purpose,
  ];
  return createHash("sha256")
    .update(JSON.stringify(canonicalTuple))
    .digest("hex");
}
