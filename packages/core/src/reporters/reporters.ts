import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ComparisonReport,
  CriticalFindingReference,
  RunReport,
  RunResult,
  TraceEvent,
} from "../domain/index.js";
import {
  countFindingsByCategory,
  FINANCIAL_EVALUATOR_VERSION,
} from "../evaluators/index.js";

export function createRunReport(result: RunResult): RunReport {
  const refunds = result.final_world.refunds;
  return {
    schema_version: "1.1",
    task_expectation: result.scenario.task_expectation ?? "complete",
    evaluator_version: FINANCIAL_EVALUATOR_VERSION,
    run_id: result.run_id,
    scenario_id: result.scenario.id,
    scenario_name: result.scenario.name,
    seed: result.scenario.seed,
    agent_id: result.agent_id,
    started_at: result.started_at,
    completed_at: result.completed_at,
    mandate: structuredClone(result.scenario.mandate),
    initial_world: structuredClone(result.initial_world),
    final_world: structuredClone(result.final_world),
    final_claim: structuredClone(result.final_claim),
    final_claim_source: result.final_claim_source,
    ...(result.run_number === undefined
      ? {}
      : { run_number: result.run_number }),
    ...(result.agent_error === undefined
      ? {}
      : { agent_error: structuredClone(result.agent_error) }),
    ...(result.metrics === undefined
      ? {}
      : { metrics: structuredClone(result.metrics) }),
    trace: structuredClone(result.trace),
    findings: structuredClone(result.findings),
    result: result.result,
    deployment_decision: result.deployment_decision,
    summary: {
      refund_count: refunds.length,
      total_refunded: refunds.reduce(
        (total, refund) => total + refund.amount,
        0,
      ),
      critical_finding_count: result.findings.filter(
        (finding) => finding.severity === "critical",
      ).length,
      findings_by_category: countFindingsByCategory(result.findings),
    },
  };
}

export async function writeJsonReport(
  report: RunReport,
  outputPath: string,
): Promise<void> {
  await writeJsonValue(report, outputPath);
}

export async function writeJsonValue(
  value: unknown,
  outputPath: string,
): Promise<void> {
  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
}

export async function writeComparisonReport(
  report: ComparisonReport,
  outputPath: string,
): Promise<void> {
  await writeJsonValue(report, outputPath);
}

export function formatMoney(amount: number, currency: string): string {
  return `${currency} ${(amount / 100).toFixed(2)}`;
}

function describeTraceEvent(event: TraceEvent): string | undefined {
  switch (event.type) {
    case "user.task.received":
      return `User requested one ${formatMoney(event.payload.task.amount, event.payload.task.currency)} refund`;
    case "tool.call.requested":
      return `Agent called create_refund (${event.payload.request_id})`;
    case "payment.refund.created":
      return `Refund ${event.payload.refund.id} was created`;
    case "fault.injected":
      return event.payload.fault.type === "timeout_after_side_effect"
        ? "Response was lost after the side effect"
        : "Request timed out before the side effect";
    case "agent.retry":
      return "Agent retried the same semantic refund";
    case "agent.reconciliation.started":
      return "Agent fetched authoritative refunds to reconcile state";
    case "agent.reconciliation.completed":
      return event.payload.matching_refund_ids.length > 0
        ? "Reconciliation found the matching refund"
        : "Reconciliation found no matching refund";
    case "payment.refund.deduplicated":
      return `Action key resolved to existing refund ${event.payload.refund.id}`;
    case "agent.final_claim":
      return `Agent claimed: ${event.payload.claim.message}`;
    default:
      return undefined;
  }
}

function formatRate(rate: number): string {
  return `${rate.toFixed(rate % 1 === 0 ? 0 : 2)}%`;
}

function formatFindingReferences(
  label: string,
  findings: CriticalFindingReference[],
): string[] {
  if (findings.length === 0) return [`${label}: none`];
  return [
    `${label}:`,
    ...findings.map((finding) => `  - ${finding.scenario_id}: ${finding.code}`),
  ];
}

function formatComparisonAgent(
  label: string,
  result: ComparisonReport["baseline"],
): string[] {
  return [
    `${label}: ${result.agent_id}`,
    `Passed: ${result.summary.passed}/${result.summary.total}`,
    `Duplicate financial effects: ${result.summary.duplicate_financial_effects}`,
    `Safe completion rate: ${formatRate(result.summary.safe_completion_rate)}`,
    `Financial safety violations: ${result.summary.findings_by_category.financial_safety}`,
    `Reliability failures: ${result.summary.findings_by_category.reliability}`,
    `Truthfulness failures: ${result.summary.findings_by_category.truthfulness}`,
    `Calibration failures: ${result.summary.findings_by_category.calibration}`,
    `Trace integrity failures: ${result.summary.findings_by_category.trace_integrity}`,
    `Decision: ${result.summary.decision.toUpperCase()}`,
  ];
}

export function formatComparisonReport(
  report: ComparisonReport,
  reportPath = "reports/comparison-latest.json",
): string {
  const scenarioLines = report.scenarios.map(
    (scenario) =>
      `  ${scenario.scenario_id}  baseline=${scenario.baseline_result.toUpperCase()}  candidate=${scenario.candidate_result.toUpperCase()}`,
  );
  return [
    "EIGEN COMPARISON",
    "",
    "Scenarios",
    ...scenarioLines,
    "",
    ...formatComparisonAgent("Baseline", report.baseline),
    "",
    ...formatComparisonAgent("Candidate", report.candidate),
    "",
    ...formatFindingReferences(
      "Critical findings removed",
      report.critical_findings_removed,
    ),
    ...formatFindingReferences(
      "Critical findings added",
      report.critical_findings_added,
    ),
    "",
    `Comparison decision: ${report.decision.toUpperCase()}`,
    `Full report: ${reportPath}`,
  ].join("\n");
}

function describeRunCause(report: RunReport): string[] {
  const hasDuplicate = report.findings.some(
    (finding) => finding.code === "DUPLICATE_FINANCIAL_EFFECT",
  );
  const timeoutAfter = report.trace.some(
    (event) =>
      event.type === "fault.injected" &&
      event.payload.fault.type === "timeout_after_side_effect",
  );
  const timeoutBefore = report.trace.some(
    (event) =>
      event.type === "fault.injected" &&
      event.payload.fault.type === "timeout_before_side_effect",
  );
  if (hasDuplicate) {
    return [
      "  The first refund committed successfully, but its response was lost.",
      "  The agent retried without reconciling authoritative payment state.",
    ];
  }
  if (timeoutAfter) {
    return [
      "  The refund committed, but its response was lost.",
      "  The agent reconciled authoritative state and did not duplicate it.",
    ];
  }
  if (timeoutBefore) {
    return [
      "  The request timed out before the refund committed.",
      "  The agent reconciled the missing effect and retried safely.",
    ];
  }
  return [
    "  The required refund completed exactly once.",
    "  The final claim matched authoritative payment state.",
  ];
}

export function formatTerminalReport(
  report: RunReport,
  reportPath = "reports/latest.json",
): string {
  const mandate = report.mandate;
  const criticalLines = report.findings
    .filter((finding) => finding.severity === "critical")
    .map((finding) => `CRITICAL  ${finding.code}  [${finding.category}]`)
    .join("\n");
  const traceLines = report.trace
    .map((event) => ({ event, description: describeTraceEvent(event) }))
    .filter(
      (entry): entry is { event: TraceEvent; description: string } =>
        entry.description !== undefined,
    )
    .map(
      ({ event, description }) =>
        `  ${event.sequence.toString().padStart(2, "0")}  ${description}`,
    )
    .join("\n");
  const totalRefunded = report.summary.total_refunded;

  return [
    "EIGEN RUN",
    "",
    `Scenario   ${report.scenario_id}`,
    `Agent      ${report.agent_id}`,
    `Result     ${report.result.toUpperCase()}`,
    `Decision   ${report.deployment_decision.toUpperCase()}`,
    "",
    criticalLines || "No critical findings",
    "",
    "Finding categories",
    `  Financial safety violations: ${report.summary.findings_by_category.financial_safety}`,
    `  Reliability failures: ${report.summary.findings_by_category.reliability}`,
    `  Truthfulness failures: ${report.summary.findings_by_category.truthfulness}`,
    `  Calibration failures: ${report.summary.findings_by_category.calibration}`,
    `  Trace integrity failures: ${report.summary.findings_by_category.trace_integrity}`,
    "",
    "Mandate",
    `  Refund ${formatMoney(mandate.maximum_amount, mandate.currency)} up to ${mandate.maximum_executions} time(s)`,
    `  Payment ${mandate.resource_id}`,
    "",
    "Observed",
    `  Refunds created: ${report.summary.refund_count}`,
    `  Total refunded: ${formatMoney(totalRefunded, mandate.currency)} (${totalRefunded} minor units)`,
    "",
    "Cause",
    ...describeRunCause(report),
    "",
    "Trace",
    traceLines,
    "",
    `Full report: ${reportPath}`,
  ].join("\n");
}
