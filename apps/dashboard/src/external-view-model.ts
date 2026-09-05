import type { ExternalRunReport } from "../server/external-report-schema";

type Event = ExternalRunReport["trace"][number];
type Finding = ExternalRunReport["findings"][number];

export function externalRunKey(
  suiteId: string,
  scenarioId: string,
  runNumber: number,
): string {
  return JSON.stringify([suiteId, scenarioId, runNumber]);
}

function integer(value: number | bigint): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Money must be a safe integer number or bigint.");
  }
  return BigInt(value);
}

/** Only currencies whose subunit scale is explicitly supported are decimalised. */
export function formatMinorUnits(amount: number | bigint, currency: string) {
  const value = integer(amount);
  const scales: Record<string, number> = {
    INR: 2,
    USD: 2,
    EUR: 2,
    GBP: 2,
    JPY: 0,
    KWD: 3,
  };
  const scale = Object.hasOwn(scales, currency) ? scales[currency] : undefined;
  if (scale === undefined) return `${currency} ${value} minor units`;
  if (scale === 0) return `${currency} ${value}`;
  const divisor = 10n ** BigInt(scale);
  const absolute = value < 0n ? -value : value;
  return `${currency} ${value < 0n ? "-" : ""}${absolute / divisor}.${String(absolute % divisor).padStart(scale, "0")}`;
}

export function financialSummary(run: ExternalRunReport) {
  const initialIds = new Set(
    run.initial_world.refunds.map((refund) => refund.id),
  );
  const committedRefunds = run.final_world.refunds.filter(
    (refund) =>
      !initialIds.has(refund.id) &&
      refund.mandate_id === run.mandate.id &&
      refund.status !== "failed",
  );
  const currency = run.mandate.currency;
  const authorizedPerRefundMinor = integer(run.mandate.maximum_amount);
  const maximumRefundCount = run.mandate.maximum_executions;
  const authorizedTotalMinor =
    authorizedPerRefundMinor * integer(maximumRefundCount);
  const totals = new Map<string, bigint>();
  for (const refund of committedRefunds) {
    totals.set(
      refund.currency,
      (totals.get(refund.currency) ?? 0n) + integer(refund.amount),
    );
  }
  const totalCommittedMinor = totals.get(currency) ?? 0n;
  const excessiveRefunds = committedRefunds.filter(
    (refund) =>
      refund.currency === currency &&
      integer(refund.amount) > authorizedPerRefundMinor,
  );
  return {
    currency,
    authorizedPerRefundMinor,
    maximumRefundCount,
    authorizedTotalMinor,
    committedRefunds,
    committedRefundCount: committedRefunds.length,
    totalCommittedMinor,
    excessMinor:
      totalCommittedMinor > authorizedTotalMinor
        ? totalCommittedMinor - authorizedTotalMinor
        : 0n,
    excessiveRefundCount: excessiveRefunds.length,
    perRefundExcessMinor: excessiveRefunds.reduce(
      (sum, refund) => sum + integer(refund.amount) - authorizedPerRefundMinor,
      0n,
    ),
    excessRefundCount: Math.max(
      0,
      committedRefunds.length - maximumRefundCount,
    ),
    otherCurrencyTotals: [...totals]
      .filter(([refundCurrency]) => refundCurrency !== currency)
      .map(([refundCurrency, amountMinor]) => ({
        currency: refundCurrency,
        amountMinor,
      })),
    claim: run.final_claim,
    claimSource: run.final_claim_source,
    modelToolSelections: run.trace.filter(
      (event) => event.type === "model.tool.selected",
    ).length,
    refundPaymentRequests: run.trace.filter(
      (event) =>
        event.type === "tool.call.requested" &&
        event.payload.operation === "create_refund",
    ).length,
    paymentReads: run.trace.filter(
      (event) => event.type === "payment.read.requested",
    ).length,
  };
}

export interface CausalStep {
  id: string;
  event: Event;
  label: string;
  detail: string;
  /** All trace events supporting this step, including the primary event. */
  eventIds: string[];
  relatedRequestEventId?: string;
}

export interface CausalExplanation {
  status: "complete" | "partial" | "unavailable";
  steps: CausalStep[];
  reason: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameCall(event: Event, callId: unknown) {
  return (
    nonempty(callId) &&
    event.correlation_id === callId &&
    (event.payload.call_id === undefined || event.payload.call_id === callId)
  );
}

function step(event: Event, label: string, detail: string): CausalStep {
  return { id: event.id, event, label, detail, eventIds: [event.id] };
}

function creationMatches(request: Event, created: Event, mandateId: string) {
  const input = record(request.payload.input);
  const refund = record(created.payload.refund);
  return (
    request.type === "tool.call.requested" &&
    request.payload.operation === "create_refund" &&
    created.type === "payment.refund.created" &&
    sameCall(request, request.payload.call_id) &&
    sameCall(created, request.payload.call_id) &&
    nonempty(request.payload.semantic_fingerprint) &&
    refund.semantic_fingerprint === request.payload.semantic_fingerprint &&
    nonempty(request.payload.request_id) &&
    refund.request_id === request.payload.request_id &&
    nonempty(request.payload.action_key) &&
    refund.action_key === request.payload.action_key &&
    refund.mandate_id === mandateId &&
    refund.status !== "failed" &&
    refund.payment_id === input.payment_id &&
    refund.amount === input.amount &&
    refund.currency === input.currency &&
    refund.purpose === input.purpose
  );
}

function sameFinancialAction(left: Event, right: Event) {
  const first = record(left.payload.refund);
  const second = record(right.payload.refund);
  return [
    "mandate_id",
    "payment_id",
    "amount",
    "currency",
    "purpose",
    "semantic_fingerprint",
  ].every((key) => first[key] !== undefined && first[key] === second[key]);
}

/** Explain observable events only; selection telemetry never implies model reasoning. */
export function causalSteps(
  run: ExternalRunReport,
  finding?: Finding,
): CausalExplanation {
  const trace = run.trace;
  const selectedFinding =
    finding ??
    run.findings.find((entry) => entry.code === "DUPLICATE_FINANCIAL_EFFECT") ??
    run.findings.find(
      (entry) => entry.code === "MANDATE_EXECUTION_COUNT_EXCEEDED",
    );
  const evidenceIds = new Set(selectedFinding?.evidence_event_ids ?? []);
  const committedIds = new Set(
    financialSummary(run).committedRefunds.map((refund) => refund.id),
  );
  const ordered = trace.every(
    (event, index) =>
      index === 0 || event.sequence > (trace[index - 1]?.sequence ?? 0),
  );
  const uniqueIds =
    new Set(trace.map((event) => event.id)).size === trace.length;
  const missingEvidence = [...evidenceIds].filter(
    (id) => !trace.some((event) => event.id === id),
  );
  const createdEvents = trace.filter(
    (event) =>
      event.type === "payment.refund.created" &&
      evidenceIds.has(event.id) &&
      committedIds.has(String(record(event.payload.refund).id)),
  );

  if (ordered && uniqueIds && missingEvidence.length === 0) {
    for (const firstCreated of createdEvents) {
      const firstRefund = record(firstCreated.payload.refund);
      const request = trace.find(
        (event) =>
          event.sequence < firstCreated.sequence &&
          creationMatches(event, firstCreated, run.mandate.id),
      );
      if (!request) continue;
      const lost = trace.find(
        (event) =>
          event.type === "fault.injected" &&
          event.sequence > firstCreated.sequence &&
          sameCall(event, request.payload.call_id) &&
          event.payload.operation === "create_refund" &&
          record(event.payload.fault).type === "timeout_after_side_effect" &&
          event.payload.refund_id === firstRefund.id,
      );
      if (!lost) continue;
      const error = trace.find(
        (event) =>
          event.type === "tool.error.returned" &&
          event.sequence > lost.sequence &&
          sameCall(event, request.payload.call_id) &&
          event.payload.ambiguous === true,
      );
      if (!error) continue;
      for (const retry of trace) {
        if (
          retry.type !== "agent.retry" ||
          retry.sequence <= error.sequence ||
          retry.payload.operation !== "create_refund" ||
          retry.payload.previous_call_id !== request.payload.call_id ||
          retry.payload.semantic_fingerprint !==
            request.payload.semantic_fingerprint ||
          !nonempty(retry.correlation_id) ||
          retry.correlation_id === request.payload.call_id
        )
          continue;
        const retryRequest = trace.find(
          (event) =>
            event.type === "tool.call.requested" &&
            event.sequence > retry.sequence &&
            sameCall(event, retry.correlation_id) &&
            event.payload.call_id === retry.correlation_id &&
            event.payload.semantic_fingerprint ===
              retry.payload.semantic_fingerprint &&
            event.payload.action_key === retry.payload.action_key,
        );
        if (!retryRequest) continue;
        const secondCreated = createdEvents.find(
          (event) =>
            event.sequence > retryRequest.sequence &&
            record(event.payload.refund).id !== firstRefund.id &&
            record(event.payload.refund).semantic_fingerprint ===
              firstRefund.semantic_fingerprint &&
            sameFinancialAction(firstCreated, event) &&
            creationMatches(retryRequest, event, run.mandate.id),
        );
        if (!secondCreated) continue;
        const lostStep = step(
          lost,
          "Response lost",
          "The response was lost after the first refund was created.",
        );
        lostStep.eventIds.push(error.id);
        const retryStep = step(
          retry,
          "Application retry",
          "Recorded retry of the same financial action, linked to the next refund payment request.",
        );
        retryStep.eventIds.push(retryRequest.id);
        retryStep.relatedRequestEventId = retryRequest.id;
        return {
          status: "complete",
          steps: [
            step(
              request,
              "Refund requested",
              "The application requested a refund from the payment world.",
            ),
            step(firstCreated, "Refund created", String(firstRefund.id)),
            lostStep,
            retryStep,
            step(
              secondCreated,
              "Second refund created",
              String(record(secondCreated.payload.refund).id),
            ),
          ],
          reason: null,
        };
      }
    }
  }

  // Without the full chain, show only individual recorded facts. No causal link is asserted.
  const steps: CausalStep[] = [];
  for (const event of trace) {
    if (selectedFinding && !evidenceIds.has(event.id)) continue;
    if (
      event.type === "tool.call.requested" &&
      event.payload.operation === "create_refund"
    ) {
      steps.push(
        step(
          event,
          "Refund requested",
          "A refund payment request is recorded.",
        ),
      );
    } else if (
      event.type === "payment.refund.created" &&
      committedIds.has(String(record(event.payload.refund).id))
    ) {
      steps.push(
        step(event, "Refund created", String(record(event.payload.refund).id)),
      );
    } else if (event.type === "fault.injected") {
      const before =
        record(event.payload.fault).type === "timeout_before_side_effect";
      steps.push(
        step(
          event,
          before ? "Timeout before refund" : "Fault recorded",
          before
            ? "The fault occurred before the payment side effect."
            : "See the raw event for the recorded fault; its connection is not established here.",
        ),
      );
    } else if (
      event.type === "tool.error.returned" ||
      event.type === "agent.run.failed"
    ) {
      steps.push(
        step(
          event,
          "Error recorded",
          String(event.payload.error_code ?? "Unknown error"),
        ),
      );
    } else if (event.type === "agent.final_claim") {
      steps.push(step(event, "Final claim recorded", run.final_claim.message));
    }
  }
  const reason =
    !ordered || !uniqueIds
      ? "The trace has invalid event order or duplicate event IDs; a causal chain cannot be established."
      : missingEvidence.length > 0
        ? `Finding evidence is missing from the trace: ${missingEvidence.join(", ")}.`
        : selectedFinding
          ? "The available finding evidence does not establish the complete request, creation, lost response, application retry and second creation chain. Correlation, matching financial identity and event order are required."
          : "No finding links two committed refunds. These are individual recorded events; a duplicate-refund causal chain is not established.";
  return {
    status: steps.length > 0 ? "partial" : "unavailable",
    steps,
    reason,
  };
}
