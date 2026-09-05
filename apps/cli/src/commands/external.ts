import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createRunReport,
  type RunReport,
  runScenario,
  SystemMonotonicTimer,
  writeJsonValue,
} from "@eigen/core";
import {
  type OpenAIEnvironment,
  validateOpenAIEnvironment,
} from "@eigen/openai-adapter";
import {
  type ExternalApplication,
  loadExternalApplication,
} from "../external/application.js";
import { ExternalProcessAgent } from "../external/process-agent.js";
import { loadScenarios } from "./compare.js";
import type { CommandIo } from "./run.js";

export interface ExternalCommandOptions {
  cwd: string;
  scenarioDirectory: string;
  appDirectory: string;
  runs: string;
  timeoutMs: string;
  io: CommandIo;
}

export interface ExternalSuiteReport {
  schema_version: "1.0";
  suite_id: string;
  environment: "simulation";
  model_execution: "openai" | "test_double";
  application: ExternalApplication;
  runs: Array<{ report_path: string; report: RunReport }>;
  decision: "allow" | "block";
}

export interface ExternalCommandDependencies {
  environment: OpenAIEnvironment;
  nextId(): string;
  modelBaseUrl?: string;
}

function boundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  option: string,
) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw new Error(
      `${option} must be an integer from ${minimum} to ${maximum}`,
    );
  return number;
}

export async function externalCommand(
  options: ExternalCommandOptions,
  dependencies: ExternalCommandDependencies = {
    environment: process.env,
    nextId: () => `external_${randomUUID()}`,
  },
): Promise<{ exitCode: 0 | 1 | 2; report?: ExternalSuiteReport }> {
  try {
    const runs = boundedInteger(options.runs, 1, 5, "--runs");
    const timeoutMs = boundedInteger(
      options.timeoutMs,
      100,
      300_000,
      "--timeout-ms",
    );
    const configuration = validateOpenAIEnvironment(dependencies.environment);
    const application = await loadExternalApplication(
      resolve(options.cwd, options.appDirectory),
    );
    const scenarios = await loadScenarios(
      resolve(options.cwd, options.scenarioDirectory),
    );
    const suiteId = dependencies.nextId();
    if (!/^[a-zA-Z0-9_-]+$/.test(suiteId)) throw new Error("Invalid suite ID");
    const suite: ExternalSuiteReport = {
      schema_version: "1.0",
      suite_id: suiteId,
      environment: "simulation",
      model_execution: dependencies.modelBaseUrl ? "test_double" : "openai",
      application,
      runs: [],
      decision: "allow",
    };
    const reportDirectory = resolve(
      options.cwd,
      "reports",
      "external",
      suiteId,
    );
    await writeJsonValue(
      { application, scenarios },
      resolve(reportDirectory, "inputs.json"),
    );
    options.io.stdout(
      `External application: ${application.id}\nPayment environment: SIMULATION\nModel execution: ${suite.model_execution}\nApplication hash: ${application.contentHash}`,
    );
    for (const original of scenarios) {
      for (let run = 1; run <= runs; run++) {
        // Explicit selection of the external adapter; retain the unmodified
        // task, authority, initial state, and fault configuration.
        const scenario = { ...original, agent: { adapter: application.id } };
        const agent = new ExternalProcessAgent({
          application,
          apiKey: configuration.apiKey,
          model: configuration.model,
          timeoutMs,
          ...(dependencies.modelBaseUrl
            ? { modelBaseUrl: dependencies.modelBaseUrl }
            : {}),
        });
        const report = createRunReport(
          await runScenario({
            scenario,
            agent,
            run_number: run,
            capture_agent_failures: true,
            timer: new SystemMonotonicTimer(),
          }),
        );
        const reportPath = `reports/external/${suiteId}/run-${suite.runs.length + 1}.json`;
        await writeJsonValue(
          { ...report, external_application: application },
          resolve(options.cwd, reportPath),
        );
        suite.runs.push({ report_path: reportPath, report });
        if (report.result !== "pass") suite.decision = "block";
        const current = await loadExternalApplication(application.directory);
        if (current.contentHash !== application.contentHash)
          throw new Error(
            "Application changed during evaluation; saved runs are not a version comparison",
          );
        options.io.stdout(
          `${scenario.id} trial ${run}: ${report.result.toUpperCase()} | ${report.summary.refund_count} refunds | ${report.summary.total_refunded} ${scenario.mandate.currency} minor units${report.agent_error ? ` | ${report.agent_error.code}` : ""}`,
        );
        for (const finding of report.findings)
          options.io.stdout(`  ${finding.code}: ${finding.explanation}`);
      }
    }
    await writeJsonValue(suite, resolve(reportDirectory, "suite.json"));
    await writeJsonValue(
      suite,
      resolve(options.cwd, "reports", "external-latest.json"),
    );
    options.io.stdout(
      `Decision: ${suite.decision.toUpperCase()}\nFull report: reports/external/${suiteId}/suite.json`,
    );
    return { exitCode: suite.decision === "allow" ? 0 : 1, report: suite };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown external integration error";
    const key = dependencies.environment.OPENAI_API_KEY;
    options.io.stderr(
      `Eigen could not evaluate the external application: ${key ? message.split(key).join("[REDACTED]") : message}`,
    );
    return { exitCode: 2 };
  }
}
