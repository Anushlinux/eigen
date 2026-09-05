import { resolve } from "node:path";
import {
  type ExternalSuiteReport,
  executeExternalSuite,
} from "@eigen/external-runner";
import type { OpenAIEnvironment } from "@eigen/openai-adapter";
import type { CommandIo } from "./run.js";

export type { ExternalSuiteReport } from "@eigen/external-runner";

export interface ExternalCommandOptions {
  cwd: string;
  scenarioDirectory: string;
  appDirectory: string;
  runs: string;
  timeoutMs: string;
  io: CommandIo;
}
export interface ExternalCommandDependencies {
  environment: OpenAIEnvironment;
  nextId(): string;
  modelBaseUrl?: string;
}

export async function externalCommand(
  options: ExternalCommandOptions,
  dependencies?: ExternalCommandDependencies,
): Promise<{ exitCode: 0 | 1 | 2; report?: ExternalSuiteReport }> {
  try {
    const report = await executeExternalSuite(
      {
        cwd: options.cwd,
        scenarioDirectory: options.scenarioDirectory,
        appDirectory: options.appDirectory,
        runs: Number(options.runs),
        timeoutMs: Number(options.timeoutMs),
        ...(resolve(options.cwd, options.scenarioDirectory) ===
        resolve(options.cwd, "scenarios/external-refunds")
          ? { reviewedSuiteId: "reviewed-refunds-v1" }
          : {}),
        onReport(run) {
          options.io.stdout(
            `${run.scenario_id} trial ${run.run_number}: ${run.result.toUpperCase()} | ${run.summary.refund_count} refunds | ${run.summary.total_refunded} ${run.mandate.currency} minor units${run.agent_error ? ` | ${run.agent_error.code}` : ""}`,
          );
          for (const finding of run.findings)
            options.io.stdout(`  ${finding.code}: ${finding.explanation}`);
        },
      },
      dependencies,
    );
    options.io.stdout(
      `External application: ${report.application.id}\nPayment environment: SIMULATION\nModel execution: ${report.model_execution}\nApplication hash: ${report.application.contentHash}\nDecision: ${report.decision.toUpperCase()}\nFull report: reports/external/${report.suite_id}/suite.json`,
    );
    return { exitCode: report.decision === "allow" ? 0 : 1, report };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown external integration error";
    const key = (dependencies?.environment ?? process.env).OPENAI_API_KEY;
    options.io.stderr(
      `Eigen could not evaluate the external application: ${key ? message.split(key).join("[REDACTED]") : message}`,
    );
    return { exitCode: 2 };
  }
}
