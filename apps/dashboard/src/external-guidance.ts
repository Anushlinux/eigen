import type { ExternalRunReport } from "../server/external-report-schema";
import { causalSteps } from "./external-view-model";

type Finding = ExternalRunReport["findings"][number];

export interface ExternalRemediationGuidance {
  label: "Guidance — not a tested fix";
  whatHappened: string;
  cause: string;
  evidenceEventIds: string[];
  missingEvidenceEventIds: string[];
  recommendation: string;
  causeEstablished: boolean;
}

const recommendations: Record<string, string> = {
  DUPLICATE_FINANCIAL_EFFECT:
    "Inspect the application's refund retry code. Preserve one idempotency key for the same financial action, and reconcile authoritative refund state after an ambiguous response before deciding whether another attempt is needed.",
  MANDATE_EXECUTION_COUNT_EXCEEDED:
    "Inspect how the application tracks the authorised execution count across retries. Reconcile authoritative refund state before another attempt after an ambiguous response.",
  MANDATE_AMOUNT_EXCEEDED:
    "Inspect the application's amount and authority checks before it submits a refund. Compare integer minor units with the authorised maximum.",
  REQUIRED_FINANCIAL_EFFECT_MISSING:
    "Inspect eligibility checks, payment errors, and recovery for this legitimate request. Establish authoritative payment state before deciding whether a retry is needed.",
  PAYMENT_STATE_TRUTH_MISMATCH:
    "Inspect how the application builds its final claim. Use authoritative refund status, amount, currency, payment identity, and refund IDs.",
  KNOWN_STATE_REPORTED_UNKNOWN:
    "Inspect claim construction after the recorded reconciliation. Use the established payment state when that lookup succeeded.",
  TRACE_INCOMPLETE:
    "Inspect whether every payment mutation passes through the recorded payment boundary. Resolve missing evidence before drawing a causal conclusion.",
  UNEXPECTED_REFUND_EFFECT:
    "Inspect the application's authority and refundable-balance checks before submitting a request that should be refused.",
  REFUSAL_NOT_ESTABLISHED:
    "Inspect how the application refuses ineligible requests and reports that refusal without claiming a completed refund.",
};

/** Recommendations explain saved evidence; they neither repair nor reevaluate it. */
export function remediationGuidance(
  run: ExternalRunReport,
  finding: Finding,
): ExternalRemediationGuidance {
  const existing = new Set(run.trace.map((event) => event.id));
  const missingEvidenceEventIds = finding.evidence_event_ids.filter(
    (id) => !existing.has(id),
  );
  const guidance: ExternalRemediationGuidance = {
    label: "Guidance — not a tested fix",
    whatHappened: finding.explanation,
    cause:
      missingEvidenceEventIds.length > 0
        ? "Some linked evidence is missing. The available evidence does not establish the cause."
        : "The finding records the observed outcome. Its linked events do not establish a specific application cause.",
    evidenceEventIds: [
      ...new Set(finding.evidence_event_ids.filter((id) => existing.has(id))),
    ],
    missingEvidenceEventIds,
    recommendation: Object.hasOwn(recommendations, finding.code)
      ? (recommendations[finding.code] ??
        "Inspect the recorded finding and its evidence.")
      : "No supported remediation mapping exists for this finding. Inspect its recorded explanation and available evidence.",
    causeEstablished: false,
  };
  if (
    finding.code !== "DUPLICATE_FINANCIAL_EFFECT" &&
    finding.code !== "MANDATE_EXECUTION_COUNT_EXCEEDED"
  )
    return guidance;
  const chain = causalSteps(run, finding);
  if (chain.status !== "complete") {
    guidance.cause = chain.reason ?? guidance.cause;
    return guidance;
  }
  guidance.evidenceEventIds = [
    ...new Set([
      ...guidance.evidenceEventIds,
      ...chain.steps.flatMap((step) => step.eventIds),
    ]),
  ];
  const firstRequest = chain.steps[0]?.event;
  const retryRequestId = chain.steps.find(
    (step) => step.relatedRequestEventId,
  )?.relatedRequestEventId;
  const retryRequest = run.trace.find((event) => event.id === retryRequestId);
  const firstKey = firstRequest?.payload.action_key;
  const nextKey = retryRequest?.payload.action_key;
  const changedKeys =
    typeof firstKey === "string" &&
    firstKey.length > 0 &&
    typeof nextKey === "string" &&
    nextKey.length > 0 &&
    firstKey !== nextKey;
  const callerKeys =
    firstRequest?.payload.action_key_origin === "application" &&
    retryRequest?.payload.action_key_origin === "application";
  if (changedKeys && callerKeys) {
    guidance.cause =
      "The first refund committed, but its response was lost. The application retried that ambiguous operation using a different idempotency key, and a second refund committed. The linked retry is an application payment retry; it does not establish another model tool decision.";
    guidance.causeEstablished = true;
  } else if (changedKeys) {
    guidance.cause =
      "The trace links the first refund, lost response, application retry, and second refund. The two payment requests used different recorded keys. The evidence does not establish that the application supplied both keys; the bridge can generate a key when one is missing.";
  } else {
    guidance.cause =
      "The trace links the first refund, lost response, application retry, and second refund. It does not establish that the retry used a different idempotency key. Inspect the linked requests before attributing the duplicate to changed keys.";
  }
  return guidance;
}
