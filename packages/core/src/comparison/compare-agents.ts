import type { AgentAdapter } from "../agents/index.js";
import type {
  AgentComparisonResult,
  ComparisonReport,
  CriticalFindingReference,
  RunReport,
  Scenario,
} from "../domain/index.js";
import {
  countFindingsByCategory,
  emptyFindingCategoryCounts,
} from "../evaluators/index.js";
import { createRunReport } from "../reporters/index.js";
import { runScenario } from "../runner/index.js";

export interface AgentVersion {
  id: string;
  create(): AgentAdapter;
}

export interface CompareAgentsInput {
  scenarios: Scenario[];
  scenarioDirectory: string;
  baseline: AgentVersion;
  candidate: AgentVersion;
}

function countDuplicateFinancialEffects(runs: RunReport[]): number {
  let duplicates = 0;
  for (const run of runs) {
    const fingerprintCounts = new Map<string, number>();
    for (const refund of run.final_world.refunds) {
      fingerprintCounts.set(
        refund.semantic_fingerprint,
        (fingerprintCounts.get(refund.semantic_fingerprint) ?? 0) + 1,
      );
    }
    for (const count of fingerprintCounts.values()) {
      duplicates += Math.max(0, count - 1);
    }
  }
  return duplicates;
}

function criticalFindings(runs: RunReport[]): CriticalFindingReference[] {
  return runs.flatMap((run) =>
    run.findings
      .filter((finding) => finding.severity === "critical")
      .map((finding) => ({
        scenario_id: run.scenario_id,
        code: finding.code,
        category: finding.category,
      })),
  );
}

function summariseAgent(
  agentId: string,
  runs: RunReport[],
): AgentComparisonResult {
  const passed = runs.filter((run) => run.result === "pass").length;
  const total = runs.length;
  const findings = criticalFindings(runs);
  const findingsByCategory = runs.reduce((counts, run) => {
    const runCounts = countFindingsByCategory(run.findings);
    for (const category of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[category] += runCounts[category];
    }
    return counts;
  }, emptyFindingCategoryCounts());
  return {
    agent_id: agentId,
    runs,
    summary: {
      passed,
      total,
      duplicate_financial_effects: countDuplicateFinancialEffects(runs),
      safe_completion_rate:
        total === 0 ? 0 : Number(((passed / total) * 100).toFixed(2)),
      findings_by_category: findingsByCategory,
      critical_findings: findings,
      decision: passed === total && findings.length === 0 ? "pass" : "block",
    },
  };
}

function findingKey(finding: CriticalFindingReference): string {
  return `${finding.scenario_id}\u0000${finding.code}`;
}

async function runSuite(
  scenarios: Scenario[],
  agent: AgentVersion,
): Promise<RunReport[]> {
  const reports: RunReport[] = [];
  for (const scenario of scenarios) {
    const adapter = agent.create();
    if (adapter.id !== agent.id) {
      throw new Error(
        `Agent factory returned ${adapter.id}, but ${agent.id} was requested`,
      );
    }
    reports.push(
      createRunReport(await runScenario({ scenario, agent: adapter })),
    );
  }
  return reports;
}

export async function compareAgentVersions(
  input: CompareAgentsInput,
): Promise<ComparisonReport> {
  if (input.scenarios.length === 0) {
    throw new Error("The comparison requires at least one scenario");
  }

  const baselineRuns = await runSuite(input.scenarios, input.baseline);
  const candidateRuns = await runSuite(input.scenarios, input.candidate);
  const baseline = summariseAgent(input.baseline.id, baselineRuns);
  const candidate = summariseAgent(input.candidate.id, candidateRuns);
  const baselineKeys = new Set(
    baseline.summary.critical_findings.map(findingKey),
  );
  const candidateKeys = new Set(
    candidate.summary.critical_findings.map(findingKey),
  );

  return {
    schema_version: "1.1",
    scenario_directory: input.scenarioDirectory,
    scenarios: input.scenarios.map((scenario, index) => ({
      scenario_id: scenario.id,
      scenario_name: scenario.name,
      seed: scenario.seed,
      baseline_result: baselineRuns[index]?.result ?? "fail",
      candidate_result: candidateRuns[index]?.result ?? "fail",
    })),
    baseline,
    candidate,
    critical_findings_removed: baseline.summary.critical_findings.filter(
      (finding) => !candidateKeys.has(findingKey(finding)),
    ),
    critical_findings_added: candidate.summary.critical_findings.filter(
      (finding) => !baselineKeys.has(findingKey(finding)),
    ),
    decision: candidate.summary.decision,
  };
}
