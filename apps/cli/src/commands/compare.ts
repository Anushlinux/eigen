import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type ComparisonReport,
  compareAgentVersions,
  formatComparisonReport,
  writeComparisonReport,
} from "@eigen/core";
import { loadScenarios } from "@eigen/external-runner";
import { type CommandIo, createAgent } from "./run.js";

export interface CompareCommandOptions {
  scenarioDirectory: string;
  baselineName: string;
  candidateName: string;
  cwd: string;
  io: CommandIo;
}

export interface CompareCommandOutcome {
  exitCode: 0 | 1 | 2;
  report?: ComparisonReport;
}

export interface CompareCommandDependencies {
  now(): string;
  nextId(): string;
  writeReport(report: ComparisonReport, outputPath: string): Promise<void>;
}

const defaultDependencies: CompareCommandDependencies = {
  now: () => new Date().toISOString(),
  nextId: () => `comparison_${randomUUID()}`,
  writeReport: writeComparisonReport,
};

export { loadScenarios } from "@eigen/external-runner";

export async function compareCommand(
  options: CompareCommandOptions,
  injectedDependencies: CompareCommandDependencies = defaultDependencies,
): Promise<CompareCommandOutcome> {
  const baseline = createAgent(options.baselineName);
  if (!baseline) {
    options.io.stderr(`Unknown baseline agent: ${options.baselineName}`);
    return { exitCode: 2 };
  }
  const candidate = createAgent(options.candidateName);
  if (!candidate) {
    options.io.stderr(`Unknown candidate agent: ${options.candidateName}`);
    return { exitCode: 2 };
  }

  try {
    const absoluteDirectory = resolve(options.cwd, options.scenarioDirectory);
    const scenarios = await loadScenarios(absoluteDirectory);
    const comparisonId = injectedDependencies.nextId();
    const createdAt = injectedDependencies.now();
    const report = await compareAgentVersions({
      comparisonId,
      createdAt,
      scenarios,
      scenarioDirectory: options.scenarioDirectory,
      baseline: {
        id: baseline.id,
        create: () => {
          const agent = createAgent(options.baselineName);
          if (!agent) throw new Error("Baseline agent became unavailable");
          return agent;
        },
      },
      candidate: {
        id: candidate.id,
        create: () => {
          const agent = createAgent(options.candidateName);
          if (!agent) throw new Error("Candidate agent became unavailable");
          return agent;
        },
      },
    });
    const historyPath = resolve(
      options.cwd,
      "reports",
      "comparisons",
      `${comparisonId}.json`,
    );
    const latestPath = resolve(
      options.cwd,
      "reports",
      "comparison-latest.json",
    );
    await injectedDependencies.writeReport(report, historyPath);
    await injectedDependencies.writeReport(report, latestPath);
    options.io.stdout(
      formatComparisonReport(report, "reports/comparison-latest.json"),
    );
    return {
      exitCode: report.decision === "pass" ? 0 : 1,
      report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.io.stderr(`Eigen could not compare the agents: ${message}`);
    return { exitCode: 2 };
  }
}
