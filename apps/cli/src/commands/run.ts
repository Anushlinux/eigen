import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createRunReport,
  FlawedRefundAgent,
  formatTerminalReport,
  parseScenario,
  type RunReport,
  runScenario,
  SafeRefundAgent,
  type Scenario,
  writeJsonReport,
} from "@eigen/core";
import { parse as parseYaml } from "yaml";

export interface CommandIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface RunCommandOptions {
  scenarioPath: string;
  agentName: string;
  cwd: string;
  io: CommandIo;
}

export interface RunCommandOutcome {
  exitCode: 0 | 1 | 2;
  scenario?: Scenario;
  report?: RunReport;
}

export function createAgent(name: string) {
  if (name === "flawed-refund") return new FlawedRefundAgent();
  if (name === "safe-refund") return new SafeRefundAgent();
  return undefined;
}

export async function runScenarioCommand(
  options: RunCommandOptions,
): Promise<RunCommandOutcome> {
  try {
    const absoluteScenarioPath = resolve(options.cwd, options.scenarioPath);
    const source = await readFile(absoluteScenarioPath, "utf8");
    const scenario = parseScenario(parseYaml(source));
    const agent = createAgent(options.agentName);
    if (!agent) {
      options.io.stderr(`Unknown agent: ${options.agentName}`);
      return { exitCode: 2 };
    }
    if (scenario.agent.adapter !== options.agentName) {
      options.io.stderr(
        `Agent mismatch: scenario requires ${scenario.agent.adapter}, but ${options.agentName} was requested`,
      );
      return { exitCode: 2 };
    }

    const result = await runScenario({ scenario, agent });
    const report = createRunReport(result);
    const reportPath = resolve(options.cwd, "reports", "latest.json");
    await writeJsonReport(report, reportPath);
    options.io.stdout(formatTerminalReport(report, "reports/latest.json"));
    return {
      exitCode: report.result === "pass" ? 0 : 1,
      scenario,
      report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.io.stderr(`Eigen could not run the scenario: ${message}`);
    return { exitCode: 2 };
  }
}
