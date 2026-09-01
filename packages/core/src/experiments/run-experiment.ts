import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentAdapter } from "../agents/index.js";
import type {
  ExperimentAgentResult,
  ExperimentMetrics,
  ExperimentReport,
  ExperimentRunReference,
  ExperimentVariationSummary,
  MonotonicTimer,
  RunReport,
  Scenario,
} from "../domain/index.js";
import {
  createRunReport,
  writeJsonReport,
  writeJsonValue,
} from "../reporters/index.js";
import { runScenario } from "../runner/index.js";

export interface ExperimentAgentFactory {
  id: string;
  create(): AgentAdapter;
}

export interface ExperimentDependencies {
  now(): string;
  nextId(prefix: string): string;
  createTimer(): MonotonicTimer;
}

export interface RunExperimentInput {
  scenarios: Scenario[];
  scenarioDirectory: string;
  agents: ExperimentAgentFactory[];
  runs: number;
  reportsDirectory: string;
  reportPathPrefix?: string | undefined;
  dependencies: ExperimentDependencies;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round((numerator / denominator) * 100);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return round(sorted[index] ?? 0);
}

function outcomeSignature(report: RunReport): string {
  const criticalCodes = report.findings
    .filter((finding) => finding.severity === "critical")
    .map((finding) => finding.code)
    .sort();
  const totalRefunded = report.final_world.refunds.reduce(
    (total, refund) => total + refund.amount,
    0,
  );
  const payload = {
    result: report.result,
    critical_codes: criticalCodes,
    refund_count: report.final_world.refunds.length,
    total_refunded: totalRefunded,
    final_status: report.final_claim.status,
    tool_call_count: report.metrics?.tool_calls ?? 0,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function variation(
  references: ExperimentRunReference[],
): ExperimentVariationSummary {
  const counts = new Map<string, number>();
  for (const reference of references) {
    counts.set(
      reference.outcome_signature,
      (counts.get(reference.outcome_signature) ?? 0) + 1,
    );
  }
  const signatures = [...counts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort(
      (first, second) =>
        second.count - first.count ||
        first.signature.localeCompare(second.signature),
    );
  const modalCount = signatures[0]?.count ?? 0;
  const modalShare =
    references.length === 0 ? 0 : round(modalCount / references.length);
  return {
    unique_outcomes: signatures.length,
    modal_share: modalShare,
    variation_rate: round(1 - modalShare),
    signatures,
  };
}

function metrics(
  reports: RunReport[],
  references: ExperimentRunReference[],
): ExperimentMetrics {
  const totalRuns = reports.length;
  const passedRuns = reports.filter(
    (report) => report.result === "pass",
  ).length;
  const criticalRuns = reports.filter((report) =>
    report.findings.some((finding) => finding.severity === "critical"),
  ).length;
  const duplicateRuns = reports.filter((report) =>
    report.findings.some(
      (finding) => finding.code === "DUPLICATE_FINANCIAL_EFFECT",
    ),
  ).length;
  const truthfulRuns = reports.filter(
    (report) =>
      !report.findings.some(
        (finding) => finding.code === "PAYMENT_STATE_TRUTH_MISMATCH",
      ),
  ).length;
  const tokenRuns = references.filter(
    (reference) =>
      reference.input_tokens !== undefined &&
      reference.output_tokens !== undefined,
  );
  const inputTokenTotal = tokenRuns.reduce(
    (total, reference) => total + (reference.input_tokens ?? 0),
    0,
  );
  const outputTokenTotal = tokenRuns.reduce(
    (total, reference) => total + (reference.output_tokens ?? 0),
    0,
  );

  return {
    total_runs: totalRuns,
    passed_runs: passedRuns,
    safe_completion_rate: rate(passedRuns, totalRuns),
    critical_violation_count: criticalRuns,
    critical_violation_rate: rate(criticalRuns, totalRuns),
    duplicate_effect_count: duplicateRuns,
    duplicate_effect_rate: rate(duplicateRuns, totalRuns),
    payment_state_truth_accuracy: rate(truthfulRuns, totalRuns),
    p50_latency_ms: percentile(
      references.map((reference) => reference.latency_ms),
      0.5,
    ),
    p95_latency_ms: percentile(
      references.map((reference) => reference.latency_ms),
      0.95,
    ),
    average_tool_call_count:
      totalRuns === 0
        ? 0
        : round(
            references.reduce(
              (total, reference) => total + reference.tool_call_count,
              0,
            ) / totalRuns,
          ),
    tokens: {
      availability:
        tokenRuns.length === 0
          ? "unavailable"
          : tokenRuns.length === totalRuns
            ? "complete"
            : "partial",
      reported_runs: tokenRuns.length,
      input_tokens: inputTokenTotal,
      output_tokens: outputTokenTotal,
      ...(tokenRuns.length === 0
        ? {}
        : {
            average_input_tokens: round(inputTokenTotal / tokenRuns.length),
            average_output_tokens: round(outputTokenTotal / tokenRuns.length),
          }),
    },
  };
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return segment.length > 0 ? segment : "unnamed";
}

function configurationFrom(reports: RunReport[]) {
  for (const report of reports) {
    const event = report.trace.find(
      (candidate) => candidate.type === "agent.configuration.loaded",
    );
    if (event?.type === "agent.configuration.loaded") return event.payload;
  }
  return {
    model: "unavailable",
    prompt_profile: "unavailable",
    prompt_hash: "unavailable",
    tool_manifest_hash: "unavailable",
  };
}

function metricDeltas(
  baseline: ExperimentMetrics,
  candidate: ExperimentMetrics,
): Record<string, number | null> {
  const delta = (first: number, second: number) => round(second - first);
  return {
    total_runs: delta(baseline.total_runs, candidate.total_runs),
    passed_runs: delta(baseline.passed_runs, candidate.passed_runs),
    safe_completion_rate: delta(
      baseline.safe_completion_rate,
      candidate.safe_completion_rate,
    ),
    critical_violation_count: delta(
      baseline.critical_violation_count,
      candidate.critical_violation_count,
    ),
    critical_violation_rate: delta(
      baseline.critical_violation_rate,
      candidate.critical_violation_rate,
    ),
    duplicate_effect_count: delta(
      baseline.duplicate_effect_count,
      candidate.duplicate_effect_count,
    ),
    duplicate_effect_rate: delta(
      baseline.duplicate_effect_rate,
      candidate.duplicate_effect_rate,
    ),
    payment_state_truth_accuracy: delta(
      baseline.payment_state_truth_accuracy,
      candidate.payment_state_truth_accuracy,
    ),
    p50_latency_ms: delta(baseline.p50_latency_ms, candidate.p50_latency_ms),
    p95_latency_ms: delta(baseline.p95_latency_ms, candidate.p95_latency_ms),
    average_tool_call_count: delta(
      baseline.average_tool_call_count,
      candidate.average_tool_call_count,
    ),
    input_tokens: delta(
      baseline.tokens.input_tokens,
      candidate.tokens.input_tokens,
    ),
    output_tokens: delta(
      baseline.tokens.output_tokens,
      candidate.tokens.output_tokens,
    ),
    average_input_tokens:
      baseline.tokens.average_input_tokens === undefined ||
      candidate.tokens.average_input_tokens === undefined
        ? null
        : delta(
            baseline.tokens.average_input_tokens,
            candidate.tokens.average_input_tokens,
          ),
    average_output_tokens:
      baseline.tokens.average_output_tokens === undefined ||
      candidate.tokens.average_output_tokens === undefined
        ? null
        : delta(
            baseline.tokens.average_output_tokens,
            candidate.tokens.average_output_tokens,
          ),
  };
}

export async function runExperiment(
  input: RunExperimentInput,
): Promise<ExperimentReport> {
  if (input.scenarios.length === 0) {
    throw new Error("The experiment requires at least one scenario");
  }
  if (!Number.isInteger(input.runs) || input.runs <= 0) {
    throw new Error("The experiment run count must be a positive integer");
  }
  if (input.agents.length !== 2) {
    throw new Error("The experiment requires exactly two agent profiles");
  }

  const experimentId = input.dependencies.nextId("experiment");
  const pathPrefix = input.reportPathPrefix ?? "reports";
  const agentResults: ExperimentAgentResult[] = [];

  for (const agentFactory of input.agents) {
    const allReports: RunReport[] = [];
    const allReferences: ExperimentRunReference[] = [];
    const scenarioResults: ExperimentAgentResult["scenarios"] = [];

    for (const scenario of input.scenarios) {
      const scenarioReports: RunReport[] = [];
      const scenarioReferences: ExperimentRunReference[] = [];
      for (let runNumber = 1; runNumber <= input.runs; runNumber += 1) {
        const agent = agentFactory.create();
        if (agent.id !== agentFactory.id) {
          throw new Error(
            `Agent factory returned ${agent.id}, but ${agentFactory.id} was requested`,
          );
        }
        const report = createRunReport(
          await runScenario({
            scenario,
            agent,
            run_number: runNumber,
            capture_agent_failures: true,
            timer: input.dependencies.createTimer(),
          }),
        );
        const relativeTracePath = join(
          pathPrefix,
          "runs",
          safeSegment(experimentId),
          safeSegment(agentFactory.id),
          safeSegment(scenario.id),
          `run-${runNumber.toString().padStart(3, "0")}.json`,
        );
        const absoluteTracePath = join(
          input.reportsDirectory,
          "runs",
          safeSegment(experimentId),
          safeSegment(agentFactory.id),
          safeSegment(scenario.id),
          `run-${runNumber.toString().padStart(3, "0")}.json`,
        );
        await writeJsonReport(report, absoluteTracePath);
        const criticalFindingCodes = report.findings
          .filter((finding) => finding.severity === "critical")
          .map((finding) => finding.code);
        const reference: ExperimentRunReference = {
          scenario_id: scenario.id,
          run_number: runNumber,
          result: report.result,
          final_status: report.final_claim.status,
          trace_path: relativeTracePath,
          outcome_signature: outcomeSignature(report),
          critical_finding_codes: criticalFindingCodes,
          latency_ms: report.metrics?.latency_ms ?? 0,
          tool_call_count: report.metrics?.tool_calls ?? 0,
          ...(report.metrics?.input_tokens === undefined
            ? {}
            : { input_tokens: report.metrics.input_tokens }),
          ...(report.metrics?.output_tokens === undefined
            ? {}
            : { output_tokens: report.metrics.output_tokens }),
        };
        scenarioReports.push(report);
        scenarioReferences.push(reference);
        allReports.push(report);
        allReferences.push(reference);
      }
      scenarioResults.push({
        scenario_id: scenario.id,
        scenario_name: scenario.name,
        metrics: metrics(scenarioReports, scenarioReferences),
        variation: variation(scenarioReferences),
        runs: scenarioReferences,
      });
    }

    const configuration = configurationFrom(allReports);
    const agentMetrics = metrics(allReports, allReferences);
    agentResults.push({
      agent_id: agentFactory.id,
      model: configuration.model,
      prompt_hash: configuration.prompt_hash,
      tool_manifest_hash: configuration.tool_manifest_hash,
      metrics: agentMetrics,
      variation: variation(allReferences),
      scenarios: scenarioResults,
      critical_traces: allReports.flatMap((report, index) => {
        const critical = report.findings.filter(
          (finding) => finding.severity === "critical",
        );
        if (critical.length === 0) return [];
        const reference = allReferences[index];
        if (!reference) return [];
        return [
          {
            scenario_id: report.scenario_id,
            run_number: reference.run_number,
            trace_path: reference.trace_path,
            findings: critical.map((finding) => ({
              code: finding.code,
              evidence_event_ids: finding.evidence_event_ids,
            })),
          },
        ];
      }),
      decision: agentMetrics.critical_violation_count > 0 ? "block" : "pass",
    });
  }

  const baseline = agentResults[0];
  const candidate = agentResults[1];
  if (!baseline || !candidate) {
    throw new Error("The experiment did not produce both agent results");
  }
  const report: ExperimentReport = {
    schema_version: "1.0",
    experiment_id: experimentId,
    created_at: input.dependencies.now(),
    scenario_directory: input.scenarioDirectory,
    runs_per_scenario: input.runs,
    agents: agentResults,
    comparison: {
      baseline_agent_id: baseline.agent_id,
      candidate_agent_id: candidate.agent_id,
      candidate_minus_baseline: metricDeltas(
        baseline.metrics,
        candidate.metrics,
      ),
      scenarios: baseline.scenarios.map((baselineScenario) => {
        const candidateScenario = candidate.scenarios.find(
          (scenario) => scenario.scenario_id === baselineScenario.scenario_id,
        );
        if (!candidateScenario) {
          throw new Error(
            `Candidate result is missing scenario ${baselineScenario.scenario_id}`,
          );
        }
        return {
          scenario_id: baselineScenario.scenario_id,
          candidate_minus_baseline: metricDeltas(
            baselineScenario.metrics,
            candidateScenario.metrics,
          ),
        };
      }),
    },
  };
  await writeJsonValue(
    report,
    join(input.reportsDirectory, "experiment-latest.json"),
  );
  return report;
}

function percent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}

export function formatExperimentReport(
  report: ExperimentReport,
  reportPath = "reports/experiment-latest.json",
): string {
  const lines = [
    "EIGEN LLM EXPERIMENT",
    "",
    `Scenarios: ${report.agents[0]?.scenarios.length ?? 0}`,
    `Runs per scenario: ${report.runs_per_scenario}`,
  ];
  for (const agent of report.agents) {
    lines.push(
      "",
      agent.agent_id,
      `Passed runs:                  ${agent.metrics.passed_runs}/${agent.metrics.total_runs}`,
      `Safe completion:              ${percent(agent.metrics.safe_completion_rate)}`,
      `Critical monetary violations: ${agent.metrics.critical_violation_count} (${percent(agent.metrics.critical_violation_rate)})`,
      `Duplicate financial effects:  ${agent.metrics.duplicate_effect_count} (${percent(agent.metrics.duplicate_effect_rate)})`,
      `Payment-state truth accuracy: ${percent(agent.metrics.payment_state_truth_accuracy)}`,
      `Repeated-run variation:       ${percent(agent.variation.variation_rate * 100)}`,
      `Latency p50 / p95:            ${agent.metrics.p50_latency_ms} ms / ${agent.metrics.p95_latency_ms} ms`,
      `Average tool calls:           ${agent.metrics.average_tool_call_count}`,
      `Token usage:                  ${agent.metrics.tokens.availability}`,
      `Decision:                     ${agent.decision.toUpperCase()}`,
    );
    if (agent.critical_traces.length > 0) {
      lines.push(
        "Critical traces:",
        ...agent.critical_traces.map(
          (trace) =>
            `  ${trace.scenario_id} run ${trace.run_number}: ${trace.trace_path}`,
        ),
      );
    }
  }
  lines.push("", `Full report: ${reportPath}`);
  return lines.join("\n");
}
