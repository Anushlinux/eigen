import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AgentExecutionPolicy,
  createRunReport,
  FINANCIAL_EVALUATOR_VERSION,
  type ModelRequestSettings,
  type RunReport,
  runScenario,
  type Scenario,
  SystemMonotonicTimer,
  type TaskExpectation,
  writeJsonValue,
} from "@eigen/core";
import {
  type OpenAIEnvironment,
  validateOpenAIEnvironment,
} from "@eigen/openai-adapter";
import {
  type ExternalApplication,
  loadExternalApplication,
} from "./application.js";
import { ExternalProcessAgent } from "./process-agent.js";
import { loadScenarios } from "./scenarios.js";

export interface ExternalProgress {
  completed: number;
  total: number;
  scenario_id?: string;
  trial?: number;
}

export interface ExternalProvenance {
  version: 1;
  reviewed_suite_id?: string;
  evaluator_version: string;
  scenarios: Array<{
    scenario_id: string;
    content_hash: string;
    scenario: Omit<Scenario, "agent">;
    task_expectation: TaskExpectation;
  }>;
  trials_per_scenario: number;
  timeout_ms: number;
  model_configuration: {
    provider: "openai";
    model: string;
    execution: "openai" | "test_double";
    verified: boolean;
    settings?: ModelRequestSettings;
    execution_policy?: AgentExecutionPolicy;
  };
  trial_matrix: Array<{
    scenario_id: string;
    run_number: number;
    task_expectation: TaskExpectation;
  }>;
}

export interface ExternalSuiteReport {
  schema_version: "1.0";
  suite_id: string;
  created_at: string;
  completed_at?: string;
  environment: "simulation";
  model_execution: "openai" | "test_double";
  application: ExternalApplication;
  provenance: ExternalProvenance;
  runs: Array<{ report_path: string; report: RunReport }>;
  decision: "allow" | "block";
}

export interface ExecuteExternalOptions {
  cwd: string;
  scenarioDirectory: string;
  appDirectory: string;
  runs: number;
  timeoutMs: number;
  reviewedSuiteId?: string;
  expectedApplicationHash?: string;
  expectedScenarioHash?: string;
  signal?: AbortSignal;
  onProgress?(progress: ExternalProgress): Promise<void> | void;
  onReport?(report: RunReport): void;
}

export interface ExternalExecutionDependencies {
  environment: OpenAIEnvironment;
  nextId?(): string;
  now?(): string;
  // This is injection for offline tests, never browser/CLI input.
  modelBaseUrl?: string;
}

export function canonicalJson(value: unknown): string {
  const normalized = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalized);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalized(child)]),
      );
    return item;
  };
  return JSON.stringify(normalized(value));
}

export function scenarioSetHash(scenarios: Scenario[]): string {
  return createHash("sha256").update(canonicalJson(scenarios)).digest("hex");
}

export function scenarioProvenance(
  scenario: Scenario,
): ExternalProvenance["scenarios"][number] {
  const { agent: _agent, ...original } = scenario;
  const normalized = {
    ...original,
    task_expectation: scenario.task_expectation ?? "complete",
  };
  return {
    scenario_id: scenario.id,
    content_hash: createHash("sha256")
      .update(canonicalJson(normalized))
      .digest("hex"),
    scenario: normalized,
    task_expectation: normalized.task_expectation,
  };
}

export function verifiedConfiguration(
  suite: ExternalSuiteReport,
): ExternalProvenance["model_configuration"] {
  const configuration = suite.provenance.model_configuration;
  const settings: ModelRequestSettings[] = [];
  const policies: AgentExecutionPolicy[] = [];
  for (const { report } of suite.runs) {
    const requests = report.trace.filter(
      (event) => event.type === "model.request.started",
    );
    const configurations = report.trace.filter(
      (event) => event.type === "agent.configuration.loaded",
    );
    if (requests.length === 0 || configurations.length !== 1)
      return configuration;
    for (const event of requests) {
      if (
        event.type !== "model.request.started" ||
        !event.payload.settings ||
        event.payload.settings.additional_parameters === undefined
      )
        return configuration;
      if (event.payload.settings.model !== configuration.model)
        return configuration;
      settings.push(event.payload.settings);
    }
    const configured = configurations[0];
    if (
      configured?.type !== "agent.configuration.loaded" ||
      !configured.payload.execution_policy
    )
      return configuration;
    policies.push(configured.payload.execution_policy);
  }
  const firstSettings = settings[0];
  const firstPolicy = policies[0];
  if (
    !firstSettings ||
    !firstPolicy ||
    settings.some(
      (value) => canonicalJson(value) !== canonicalJson(firstSettings),
    ) ||
    policies.some(
      (value) => canonicalJson(value) !== canonicalJson(firstPolicy),
    )
  )
    return configuration;
  return {
    ...configuration,
    verified: true,
    settings: firstSettings,
    execution_policy: firstPolicy,
  };
}

/** The single external evaluation path used by CLI and dashboard jobs. */
export async function executeExternalSuite(
  options: ExecuteExternalOptions,
  dependencies: ExternalExecutionDependencies = { environment: process.env },
): Promise<ExternalSuiteReport> {
  if (
    !Number.isSafeInteger(options.runs) ||
    options.runs < 1 ||
    options.runs > 5
  )
    throw new Error("--runs must be an integer from 1 to 5");
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 300_000
  )
    throw new Error("--timeout-ms must be an integer from 100 to 300000");
  options.signal?.throwIfAborted();
  const configuration = validateOpenAIEnvironment(dependencies.environment);
  const application = await loadExternalApplication(
    resolve(options.cwd, options.appDirectory),
  );
  if (
    options.expectedApplicationHash &&
    application.contentHash !== options.expectedApplicationHash
  )
    throw new Error(
      "Application changed after setup validation. Rebuild and start a new evaluation.",
    );
  const scenarios = await loadScenarios(
    resolve(options.cwd, options.scenarioDirectory),
  );
  if (
    options.expectedScenarioHash &&
    scenarioSetHash(scenarios) !== options.expectedScenarioHash
  )
    throw new Error(
      "Reviewed scenarios changed after setup validation. Restore the suite and start a new evaluation.",
    );
  const suiteId = dependencies.nextId?.() ?? `external_${randomUUID()}`;
  if (!/^[a-zA-Z0-9_-]+$/.test(suiteId)) throw new Error("Invalid suite ID");
  const now = dependencies.now ?? (() => new Date().toISOString());
  const modelExecution = dependencies.modelBaseUrl ? "test_double" : "openai";
  const suite: ExternalSuiteReport = {
    schema_version: "1.0",
    suite_id: suiteId,
    created_at: now(),
    environment: "simulation",
    model_execution: modelExecution,
    application,
    provenance: {
      version: 1,
      ...(options.reviewedSuiteId
        ? { reviewed_suite_id: options.reviewedSuiteId }
        : {}),
      evaluator_version: FINANCIAL_EVALUATOR_VERSION,
      scenarios: scenarios.map(scenarioProvenance),
      trials_per_scenario: options.runs,
      timeout_ms: options.timeoutMs,
      model_configuration: {
        provider: "openai",
        model: configuration.model,
        execution: modelExecution,
        verified: false,
      },
      trial_matrix: scenarios.flatMap((scenario) =>
        Array.from({ length: options.runs }, (_, index) => ({
          scenario_id: scenario.id,
          run_number: index + 1,
          task_expectation: scenario.task_expectation ?? "complete",
        })),
      ),
    },
    runs: [],
    decision: "allow",
  };
  const reportRoot = resolve(options.cwd, "reports", "external");
  const reportDirectory = resolve(reportRoot, suiteId);
  await mkdir(reportRoot, { recursive: true });
  // A colliding identifier must never replace a prior evaluation.
  await mkdir(reportDirectory);
  await writeJsonValue(
    { application, scenarios, provenance: suite.provenance },
    resolve(reportDirectory, "inputs.json"),
  );
  const total = scenarios.length * options.runs;
  for (const original of scenarios) {
    for (let trial = 1; trial <= options.runs; trial++) {
      options.signal?.throwIfAborted();
      const before = await loadExternalApplication(application.directory);
      if (before.contentHash !== application.contentHash)
        throw new Error(
          "Application changed during evaluation; saved runs are not a version comparison",
        );
      await options.onProgress?.({
        completed: suite.runs.length,
        total,
        scenario_id: original.id,
        trial,
      });
      const scenario = { ...original, agent: { adapter: application.id } };
      const report = createRunReport(
        await runScenario({
          scenario,
          agent: new ExternalProcessAgent({
            application,
            apiKey: configuration.apiKey,
            model: configuration.model,
            timeoutMs: options.timeoutMs,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(dependencies.modelBaseUrl
              ? { modelBaseUrl: dependencies.modelBaseUrl }
              : {}),
          }),
          run_number: trial,
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
      options.signal?.throwIfAborted();
      const after = await loadExternalApplication(application.directory);
      if (after.contentHash !== application.contentHash)
        throw new Error(
          "Application changed during evaluation; saved runs are not a version comparison",
        );
      options.onReport?.(report);
      await options.onProgress?.({
        completed: suite.runs.length,
        total,
        scenario_id: original.id,
        trial,
      });
    }
  }
  suite.provenance.model_configuration = verifiedConfiguration(suite);
  suite.completed_at = now();
  options.signal?.throwIfAborted();
  await writeJsonValue(suite, resolve(reportDirectory, "suite.json"));
  await writeJsonValue(
    suite,
    resolve(options.cwd, "reports", "external-latest.json"),
  );
  return suite;
}
