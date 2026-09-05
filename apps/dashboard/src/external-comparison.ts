import {
  type ExternalComparisonProvenance,
  type ExternalRunReport,
  type ExternalSuiteReport,
  externalComparisonProvenanceSchema,
} from "../server/external-report-schema";

type Expectation = "complete" | "refuse";

export interface ExternalTrialOutcome {
  runNumber: number;
  result: "pass" | "fail";
  financialViolations: number;
  executionError: boolean;
  taskExpectation: Expectation | null;
}

export interface ExternalSuiteOutcome {
  suiteId: string;
  applicationHash: string;
  model: string | null;
  configuration: unknown;
  promptHashes: string[];
  toolManifestHashes: string[];
  totalTrials: number;
  passedTrials: number;
  failedTrials: number;
  executionErrors: number;
  financialViolations: number;
  legitimateCompletion: { passed: number; total: number } | null;
  refusalCompletion: { passed: number; total: number } | null;
}

export interface ExternalScenarioComparison {
  scenarioId: string;
  scenarioName: string;
  before: ExternalTrialOutcome[];
  after: ExternalTrialOutcome[];
}

export interface ExternalSuiteComparison {
  directlyComparable: boolean;
  compatibilityReasons: string[];
  before: ExternalSuiteOutcome;
  after: ExternalSuiteOutcome;
  scenarios: ExternalScenarioComparison[];
  conclusion: string;
}

/** Compare actual structured contents; a supplied digest alone is not proof. */
function canonical(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === "object")
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return entry;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

function same(left: unknown, right: unknown) {
  return canonical(left) === canonical(right);
}

function trialKey(scenarioId: string, runNumber: number) {
  return JSON.stringify([scenarioId, runNumber]);
}

function isExecutionError(run: ExternalRunReport) {
  return (
    run.agent_error !== undefined ||
    run.final_claim_source === "eigen_failure_fallback" ||
    run.trace.some((event) => event.type === "agent.run.failed")
  );
}

function financialViolations(run: ExternalRunReport) {
  return run.findings.filter(
    (finding) => finding.category === "financial_safety",
  ).length;
}

async function inspectProvenance(suite: ExternalSuiteReport) {
  const parsed = externalComparisonProvenanceSchema.safeParse(suite.provenance);
  const reasons: string[] = [];
  const expectations = new Map<string, Expectation>();
  if (!parsed.success) {
    return {
      provenance: null,
      expectations,
      expectationEvidenceValid: false,
      reasons: [
        suite.provenance === undefined
          ? "Comparison provenance was not recorded."
          : "Comparison provenance is incomplete, malformed, or uses an unsupported version.",
      ],
    };
  }
  const provenance = parsed.data;
  const scenarios = new Map<string, (typeof provenance.scenarios)[number]>();
  for (const scenario of provenance.scenarios) {
    try {
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(scenario.scenario)),
      );
      const actualHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (actualHash !== scenario.content_hash.toLowerCase())
        reasons.push(
          "A scenario content hash does not match its recorded contents.",
        );
    } catch {
      reasons.push(
        "Scenario content hashes could not be verified in this environment.",
      );
    }
    if (
      scenarios.has(scenario.scenario_id) ||
      scenario.scenario.id !== scenario.scenario_id ||
      scenario.scenario.task_expectation !== scenario.task_expectation
    )
      reasons.push("Scenario identities or expectations are inconsistent.");
    scenarios.set(scenario.scenario_id, scenario);
  }
  for (const trial of provenance.trial_matrix) {
    const key = trialKey(trial.scenario_id, trial.run_number);
    if (
      expectations.has(key) ||
      !scenarios.has(trial.scenario_id) ||
      scenarios.get(trial.scenario_id)?.task_expectation !==
        trial.task_expectation ||
      trial.run_number > provenance.trials_per_scenario
    )
      reasons.push("The recorded trial matrix is inconsistent.");
    expectations.set(key, trial.task_expectation);
  }
  const expectedCount = scenarios.size * provenance.trials_per_scenario;
  if (
    expectations.size !== expectedCount ||
    suite.runs.length !== expectedCount
  )
    reasons.push(
      "The suite does not contain the complete recorded trial matrix.",
    );
  for (const { report: run } of suite.runs) {
    const scenario = scenarios.get(run.scenario_id)?.scenario;
    const taskEvent = run.trace.find(
      (event) => event.type === "user.task.received",
    );
    if (
      !expectations.has(trialKey(run.scenario_id, run.run_number)) ||
      !scenario ||
      run.task_expectation !== scenario.task_expectation ||
      run.evaluator_version !== provenance.evaluator_version ||
      scenario.seed !== run.seed ||
      !same(scenario.mandate, run.mandate) ||
      !same(scenario.initial_world.payments, run.initial_world.payments) ||
      run.initial_world.refunds.length !== 0 ||
      !same(scenario.user_task, taskEvent?.payload.task)
    )
      reasons.push(
        "A saved trial does not match its recorded scenario inputs.",
      );
  }
  const expectationEvidenceValid = reasons.length === 0;
  const config = provenance.model_configuration;
  if (!provenance.reviewed_suite_id)
    reasons.push("A reviewed suite identity was not recorded.");
  if (
    !config.verified ||
    !config.settings ||
    config.settings.additional_parameters === undefined ||
    !config.execution_policy ||
    config.model !== config.settings.model ||
    config.execution !== suite.model_execution
  )
    reasons.push(
      "Actual model settings and execution policy are not verified.",
    );
  else {
    for (const { report: run } of suite.runs) {
      const requests = run.trace.filter(
        (event) => event.type === "model.request.started",
      );
      const configuration = run.trace.filter(
        (event) => event.type === "agent.configuration.loaded",
      );
      if (
        requests.length === 0 ||
        requests.some(
          (event) =>
            event.payload.model !== config.model ||
            !same(event.payload.settings, config.settings),
        ) ||
        configuration.length !== 1 ||
        configuration.some(
          (event) =>
            event.payload.model !== config.model ||
            !same(event.payload.execution_policy, config.execution_policy),
        )
      )
        reasons.push(
          "Model settings provenance does not match every trial's telemetry.",
        );
    }
  }
  return {
    provenance,
    expectations,
    expectationEvidenceValid,
    reasons: [...new Set(reasons)],
  };
}

type Inspected = Awaited<ReturnType<typeof inspectProvenance>>;

function outcome(
  suite: ExternalSuiteReport,
  inspected: Inspected,
): ExternalSuiteOutcome {
  const runs = suite.runs.map(({ report }) => report);
  const configurationEvents = runs.flatMap((run) =>
    run.trace.filter((event) => event.type === "agent.configuration.loaded"),
  );
  const values = (key: string) =>
    [
      ...new Set(
        configurationEvents.flatMap((event) =>
          typeof event.payload[key] === "string"
            ? [event.payload[key] as string]
            : [],
        ),
      ),
    ].sort();
  const completion = (expectation: Expectation) => {
    if (!inspected.expectationEvidenceValid) return null;
    const relevant = runs.filter(
      (run) =>
        inspected.expectations.get(
          trialKey(run.scenario_id, run.run_number),
        ) === expectation,
    );
    return {
      passed: relevant.filter(
        (run) => run.result === "pass" && !isExecutionError(run),
      ).length,
      total: relevant.length,
    };
  };
  const models = values("model");
  return {
    suiteId: suite.suite_id,
    applicationHash: suite.application.contentHash,
    model:
      inspected.provenance?.model_configuration.model ??
      (models.length === 1 ? (models[0] ?? null) : null),
    configuration: inspected.provenance?.model_configuration ?? null,
    promptHashes: values("prompt_hash"),
    toolManifestHashes: values("tool_manifest_hash"),
    totalTrials: runs.length,
    passedTrials: runs.filter(
      (run) => run.result === "pass" && !isExecutionError(run),
    ).length,
    failedTrials: runs.filter(
      (run) => run.result === "fail" || isExecutionError(run),
    ).length,
    executionErrors: runs.filter(isExecutionError).length,
    financialViolations: runs.reduce(
      (total, run) => total + financialViolations(run),
      0,
    ),
    legitimateCompletion: completion("complete"),
    refusalCompletion: completion("refuse"),
  };
}

function sortedScenarios(provenance: ExternalComparisonProvenance) {
  return [...provenance.scenarios].sort((left, right) =>
    left.scenario_id.localeCompare(right.scenario_id),
  );
}

/** Summarizes saved verdicts. It never runs financial evaluators in the browser. */
export async function compareExternalSuites(
  before: ExternalSuiteReport,
  after: ExternalSuiteReport,
): Promise<ExternalSuiteComparison> {
  const [first, second] = await Promise.all([
    inspectProvenance(before),
    inspectProvenance(after),
  ]);
  const reasons = [
    ...first.reasons.map((reason) => `Before: ${reason}`),
    ...second.reasons.map((reason) => `After: ${reason}`),
  ];
  if (before.suite_id === after.suite_id)
    reasons.push("Choose two different saved suites.");
  if (before.application.id !== after.application.id)
    reasons.push("The application identities differ.");
  if (before.model_execution !== after.model_execution)
    reasons.push("The model execution environments differ.");
  if (first.provenance && second.provenance) {
    const left = first.provenance;
    const right = second.provenance;
    if (left.reviewed_suite_id !== right.reviewed_suite_id)
      reasons.push("The reviewed suites differ.");
    if (left.evaluator_version !== right.evaluator_version)
      reasons.push("The evaluator versions differ.");
    if (!same(sortedScenarios(left), sortedScenarios(right)))
      reasons.push(
        "Scenario contents, authority, initial state, faults, seeds, or expectations differ.",
      );
    if (
      left.trials_per_scenario !== right.trials_per_scenario ||
      !same(
        [...left.trial_matrix].sort((a, b) =>
          trialKey(a.scenario_id, a.run_number).localeCompare(
            trialKey(b.scenario_id, b.run_number),
          ),
        ),
        [...right.trial_matrix].sort((a, b) =>
          trialKey(a.scenario_id, a.run_number).localeCompare(
            trialKey(b.scenario_id, b.run_number),
          ),
        ),
      )
    )
      reasons.push("Trial counts or the trial matrices differ.");
    if (left.timeout_ms !== right.timeout_ms)
      reasons.push("Trial timeout limits differ.");
    if (!same(left.model_configuration, right.model_configuration))
      reasons.push("Model settings or execution policies differ.");
  }
  const scenarios = new Map<string, string>();
  for (const suite of [before, after])
    for (const { report } of suite.runs)
      scenarios.set(report.scenario_id, report.scenario_name);
  const trials = (
    suite: ExternalSuiteReport,
    inspected: Inspected,
    scenarioId: string,
  ) =>
    suite.runs
      .filter(({ report }) => report.scenario_id === scenarioId)
      .map(
        ({ report: run }): ExternalTrialOutcome => ({
          runNumber: run.run_number,
          result: run.result,
          financialViolations: financialViolations(run),
          executionError: isExecutionError(run),
          taskExpectation: inspected.expectationEvidenceValid
            ? (inspected.expectations.get(
                trialKey(run.scenario_id, run.run_number),
              ) ?? null)
            : null,
        }),
      )
      .sort((left, right) => left.runNumber - right.runNumber);
  return {
    directlyComparable: reasons.length === 0,
    compatibilityReasons: [...new Set(reasons)],
    before: outcome(before, first),
    after: outcome(after, second),
    scenarios: [...scenarios].map(([scenarioId, scenarioName]) => ({
      scenarioId,
      scenarioName,
      before: trials(before, first, scenarioId),
      after: trials(after, second, scenarioId),
    })),
    conclusion:
      reasons.length === 0
        ? "Matching evaluation conditions. Results describe which trials passed; they do not prove that an application change caused the difference or guarantee future outcomes."
        : "These saved results are not directly comparable. Differences cannot be attributed to the application change.",
  };
}
