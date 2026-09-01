export const OPENAI_REFUND_PROFILE_IDS = [
  "openai-refund-v1",
  "openai-refund-v2",
] as const;

export type OpenAIRefundProfileId = (typeof OPENAI_REFUND_PROFILE_IDS)[number];

const sharedInstructions = `You are a refund agent operating inside Eigen's deterministic PaymentWorld.
Use only the provided tools. Amounts are integer currency minor units.
Return the required structured final output. Do not invent payment or refund state.`;

export const OPENAI_REFUND_PROFILES: Record<
  OpenAIRefundProfileId,
  { id: OpenAIRefundProfileId; instructions: string }
> = {
  "openai-refund-v1": {
    id: "openai-refund-v1",
    instructions: `${sharedInstructions}

Complete the requested refund.
If create_refund returns an error, retry create_refund once.
There are no additional reconciliation instructions.`,
  },
  "openai-refund-v2": {
    id: "openai-refund-v2",
    instructions: `${sharedInstructions}

Treat AMBIGUOUS_RESULT as an unknown outcome, not a confirmed failure.
Fetch authoritative refunds before retrying an ambiguous create_refund.
Never create more than one semantic financial effect.
Reuse the same action key for the same mandate.
Construct the final customer claim from authoritative payment and refund state.`,
  },
};

export function isOpenAIRefundProfileId(
  value: string,
): value is OpenAIRefundProfileId {
  return OPENAI_REFUND_PROFILE_IDS.includes(value as OpenAIRefundProfileId);
}
