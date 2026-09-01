import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  type ComparisonReport,
  compareAgentVersions,
  formatComparisonReport,
  parseScenario,
  type Scenario,
  writeComparisonReport,
} from "@eigen/core";
import { parse as parseYaml } from "yaml";
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

export async function loadScenarios(
  directoryPath: string,
): Promise<Scenario[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const scenarioFiles = entries
    .filter(
      (entry) =>
        entry.isFile() && [".yaml", ".yml"].includes(extname(entry.name)),
    )
    .map((entry) => entry.name)
    .sort((first, second) => first.localeCompare(second));
  if (scenarioFiles.length === 0) {
    throw new Error(`No YAML scenarios found in ${directoryPath}`);
  }

  const scenarios = await Promise.all(
    scenarioFiles.map(async (fileName) => {
      const source = await readFile(resolve(directoryPath, fileName), "utf8");
      return parseScenario(parseYaml(source));
    }),
  );
  const seenIds = new Set<string>();
  for (const scenario of scenarios) {
    if (seenIds.has(scenario.id)) {
      throw new Error(`Duplicate scenario ID: ${scenario.id}`);
    }
    seenIds.add(scenario.id);
  }
  return scenarios;
}

export async function compareCommand(
  options: CompareCommandOptions,
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
    const report = await compareAgentVersions({
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
    const reportPath = resolve(
      options.cwd,
      "reports",
      "comparison-latest.json",
    );
    await writeComparisonReport(report, reportPath);
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
