import type { RunReport, TraceEvent } from "./types";

export type MilestoneTone = "neutral" | "good" | "fault" | "danger";

export interface Milestone {
  id: string;
  event: TraceEvent | undefined;
  label: string;
  detail: string;
  tone: MilestoneTone;
  slot: number;
}

function refundId(event: TraceEvent): string | undefined {
  const refund = event.payload.refund;
  if (!refund || typeof refund !== "object" || !("id" in refund))
    return undefined;
  return typeof refund.id === "string" ? refund.id : undefined;
}

export function eventLabel(event: TraceEvent): string {
  switch (event.type) {
    case "user.task.received":
      return "Refund requested";
    case "mandate.loaded":
      return "One refund authorised";
    case "tool.call.requested":
      return "create_refund requested";
    case "payment.refund.created":
      return `Refund ${refundId(event) ?? "created"}`;
    case "fault.injected":
      return "Response lost";
    case "tool.error.returned":
      return "Ambiguous result returned";
    case "agent.retry":
      return "Agent retries";
    case "agent.reconciliation.started":
      return "Checks provider state";
    case "agent.reconciliation.completed":
      return "Matching refund found";
    case "payment.refund.observed":
      return "Provider refund observed";
    case "agent.final_claim":
      return "User-facing claim";
    case "evaluator.finding":
      return "Deterministic finding";
    case "run.completed":
      return "Decision recorded";
    default:
      return event.type.replaceAll(".", " ");
  }
}

export function eventTone(event: TraceEvent): MilestoneTone {
  if (event.type === "fault.injected" || event.type === "tool.error.returned") {
    return "fault";
  }
  if (event.type === "agent.retry") return "danger";
  if (event.type === "evaluator.finding") return "danger";
  if (
    event.type.startsWith("agent.reconciliation") ||
    event.type === "payment.refund.observed" ||
    event.type === "run.completed"
  ) {
    return "good";
  }
  return "neutral";
}

export function milestonesForRun(run: RunReport): Milestone[] {
  const milestones: Milestone[] = [];
  let createdCount = 0;
  let faultIndex = -1;
  let reconciliationStarted = false;
  let reconciliationCompleted = false;
  for (const event of run.trace) {
    let milestone: Milestone | undefined;
    if (event.type === "mandate.loaded") {
      milestone = {
        id: event.id,
        event,
        label: "Authorised",
        detail: "Mandate permits one refund",
        tone: "neutral",
        slot: 1,
      };
    } else if (event.type === "payment.refund.created") {
      createdCount += 1;
      milestone = {
        id: event.id,
        event,
        label: createdCount === 1 ? "Refund committed" : "Second refund",
        detail: refundId(event) ?? "Provider effect",
        tone: createdCount === 1 ? "neutral" : "danger",
        slot: createdCount === 1 ? 2 : 5,
      };
    } else if (event.type === "fault.injected") {
      milestone = {
        id: event.id,
        event,
        label: "Response lost",
        detail: "After provider side effect",
        tone: "fault",
        slot: 3,
      };
    } else if (event.type === "agent.retry") {
      milestone = {
        id: event.id,
        event,
        label: "Retry",
        detail: "Same semantic action",
        tone: "danger",
        slot: 4,
      };
    } else if (
      event.type === "agent.reconciliation.started" &&
      !reconciliationStarted
    ) {
      reconciliationStarted = true;
      milestone = {
        id: event.id,
        event,
        label: "Check provider",
        detail: "Fetch authoritative refunds",
        tone: "good",
        slot: 4,
      };
    } else if (
      event.type === "agent.reconciliation.completed" &&
      !reconciliationCompleted
    ) {
      reconciliationCompleted = true;
      milestone = {
        id: event.id,
        event,
        label: "Same refund found",
        detail: "Correlation matched",
        tone: "good",
        slot: 5,
      };
    } else if (event.type === "agent.final_claim") {
      milestone = {
        id: event.id,
        event,
        label: run.result === "pass" ? "Truthful claim" : "Claim issued",
        detail: run.final_claim.message,
        tone: run.result === "pass" ? "good" : "danger",
        slot: 8,
      };
    }
    if (milestone) {
      if (milestone.label === "Response lost") faultIndex = milestones.length;
      milestones.push(milestone);
    }
  }
  const hasFault = faultIndex >= 0;
  const hasRetry = run.trace.some((event) => event.type === "agent.retry");
  const reconciled = run.trace.some(
    (event) => event.type === "agent.reconciliation.completed",
  );
  if (hasFault && reconciled && !hasRetry) {
    const claimIndex = milestones.findIndex(
      (item) => item.label === "Truthful claim",
    );
    const evidence = run.trace.find((event) => event.type === "run.completed");
    milestones.splice(claimIndex >= 0 ? claimIndex : milestones.length, 0, {
      id: `${run.run_id}_no_retry`,
      event: evidence,
      label: "No retry",
      detail: "No second mutation requested",
      tone: "good",
      slot: 6,
    });
  }
  return milestones;
}

export function meaningfulEvents(run: RunReport): TraceEvent[] {
  const types = new Set([
    "user.task.received",
    "mandate.loaded",
    "tool.call.requested",
    "payment.refund.created",
    "fault.injected",
    "tool.error.returned",
    "agent.retry",
    "agent.reconciliation.started",
    "agent.reconciliation.completed",
    "payment.refund.observed",
    "agent.final_claim",
    "evaluator.finding",
    "run.completed",
  ]);
  return run.trace.filter((event) => types.has(event.type));
}
