import { describe, expect, it } from "vitest";
import fixture from "../fixtures/external-suite.json";
import { externalSuiteReportSchema } from "../server/external-report-schema";
import { remediationGuidance } from "./external-guidance";
import { causalSteps } from "./external-view-model";

function duplicate() {
  const suite = externalSuiteReportSchema.parse(structuredClone(fixture));
  const run = suite.runs.find(({ report }) =>
    report.findings.some(
      (finding) => finding.code === "DUPLICATE_FINANCIAL_EFFECT",
    ),
  )?.report;
  if (!run) throw new Error("Missing fixture run");
  const finding = run.findings.find(
    (entry) => entry.code === "DUPLICATE_FINANCIAL_EFFECT",
  );
  if (!finding) throw new Error("Missing fixture finding");
  for (const event of run.trace)
    if (event.type === "tool.call.requested")
      event.payload.action_key_origin = "application";
  return { run, finding };
}

describe("evidence-backed external remediation guidance", () => {
  it("explains changed caller keys using exact recorded application retry evidence", () => {
    const { run, finding } = duplicate();
    const guidance = remediationGuidance(run, finding);
    expect(guidance.causeEstablished).toBe(true);
    expect(guidance.cause).toContain(
      "application retried that ambiguous operation using a different idempotency key",
    );
    expect(guidance.cause).toContain(
      "does not establish another model tool decision",
    );
    expect(guidance.label).toBe("Guidance — not a tested fix");
    expect(guidance.whatHappened).toBe(finding.explanation);
    for (const step of causalSteps(run, finding).steps)
      for (const id of step.eventIds)
        expect(guidance.evidenceEventIds).toContain(id);
    expect(guidance.recommendation).toContain(
      "Inspect the application's refund retry code",
    );
    expect(guidance).not.toHaveProperty("sourceLine");
  });

  it.each([undefined, "bridge_generated"])(
    "does not attribute bridge or unknown keys to the application: %s",
    (origin) => {
      const { run, finding } = duplicate();
      const request = run.trace.find(
        (event) => event.type === "tool.call.requested",
      );
      if (!request) throw new Error("Missing fixture request");
      if (origin === undefined) delete request.payload.action_key_origin;
      else request.payload.action_key_origin = origin;
      const guidance = remediationGuidance(run, finding);
      expect(guidance.causeEstablished).toBe(false);
      expect(guidance.cause).toContain("different recorded keys");
      expect(guidance.cause).toContain(
        "does not establish that the application supplied both keys",
      );
    },
  );

  it("does not invent changed keys when the recorded action keys match", () => {
    const { run, finding } = duplicate();
    const requests = run.trace.filter(
      (event) => event.type === "tool.call.requested",
    );
    const first = requests[0];
    const second = requests[1];
    if (!first || !second) throw new Error("Missing fixture requests");
    const key = first.payload.action_key;
    second.payload.action_key = key;
    for (const event of run.trace) {
      if (event.type === "agent.retry") event.payload.action_key = key;
      if (
        event.type === "payment.refund.created" &&
        event.correlation_id === second.correlation_id
      )
        (event.payload.refund as Record<string, unknown>).action_key = key;
    }
    expect(causalSteps(run, finding).status).toBe("complete");
    const guidance = remediationGuidance(run, finding);
    expect(guidance.causeEstablished).toBe(false);
    expect(guidance.cause).toContain(
      "does not establish that the retry used a different idempotency key",
    );
  });

  it.each([
    "fault.injected",
    "agent.retry",
    "tool.error.returned",
    "tool.call.requested",
    "payment.refund.created",
  ])("does not invent a cause without %s", (type) => {
    const { run, finding } = duplicate();
    const index = run.trace.findIndex((event) => event.type === type);
    run.trace.splice(index, 1);
    const guidance = remediationGuidance(run, finding);
    expect(guidance.causeEstablished).toBe(false);
    expect(guidance.cause).not.toContain(
      "application retried that ambiguous operation using a different idempotency key",
    );
    expect(
      guidance.evidenceEventIds.every((id) =>
        run.trace.some((event) => event.id === id),
      ),
    ).toBe(true);
  });

  it("rejects unrelated correlation and invalid event ordering", () => {
    const { run, finding } = duplicate();
    const retry = run.trace.find((event) => event.type === "agent.retry");
    if (!retry) throw new Error("Missing retry");
    retry.payload.previous_call_id = "unrelated";
    expect(remediationGuidance(run, finding).causeEstablished).toBe(false);
    const next = duplicate();
    next.run.trace.reverse();
    expect(remediationGuidance(next.run, next.finding).causeEstablished).toBe(
      false,
    );
  });

  it("exposes missing finding evidence without using unrelated events as its replacement", () => {
    const { run, finding } = duplicate();
    finding.evidence_event_ids = ["missing"];
    const guidance = remediationGuidance(run, finding);
    expect(guidance.causeEstablished).toBe(false);
    expect(guidance.evidenceEventIds).toEqual([]);
    expect(guidance.missingEvidenceEventIds).toEqual(["missing"]);
  });

  it.each([
    "MANDATE_AMOUNT_EXCEEDED",
    "REQUIRED_FINANCIAL_EFFECT_MISSING",
    "PAYMENT_STATE_TRUTH_MISMATCH",
    "KNOWN_STATE_REPORTED_UNKNOWN",
    "TRACE_INCOMPLETE",
    "UNEXPECTED_REFUND_EFFECT",
    "REFUSAL_NOT_ESTABLISHED",
  ])(
    "offers limited inspection guidance for %s without inventing its cause",
    (code) => {
      const { run, finding } = duplicate();
      finding.code = code;
      const guidance = remediationGuidance(run, finding);
      expect(guidance.causeEstablished).toBe(false);
      expect(guidance.recommendation).toContain("Inspect");
      expect(guidance.whatHappened).toBe(finding.explanation);
    },
  );

  it("keeps unsupported findings readable without inventing remediation", () => {
    const { run, finding } = duplicate();
    finding.code = "FUTURE_FINDING";
    const original = structuredClone(run);
    const guidance = remediationGuidance(run, finding);
    expect(guidance.causeEstablished).toBe(false);
    expect(guidance.recommendation).toContain(
      "No supported remediation mapping",
    );
    expect(run).toEqual(original);
  });
});
