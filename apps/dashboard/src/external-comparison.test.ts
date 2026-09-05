import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/external-suite.json";
import {
  type ExternalComparisonProvenance,
  externalComparisonProvenanceSchema,
  externalSuiteReportSchema,
} from "../server/external-report-schema";
import { compareExternalSuites } from "./external-comparison";

function hashScenario(value: unknown): string {
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
  return createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex");
}

function suite(id = "before") {
  const report = externalSuiteReportSchema.parse(structuredClone(fixture));
  report.suite_id = id;
  const settings = {
    settings_version: 1 as const,
    model: "offline-model",
    store: true,
    max_output_tokens: 2500,
    parallel_tool_calls: false,
    additional_parameters: {},
  };
  const executionPolicy = { max_turns: 4, model_timeout_ms: 60_000 };
  for (const { report: run } of report.runs) {
    run.task_expectation = "complete";
    run.evaluator_version = "refund-evaluator-v2";
    for (const event of run.trace) {
      if (event.type === "model.request.started") {
        event.payload.model = settings.model;
        event.payload.settings = structuredClone(settings);
      }
      if (event.type === "agent.configuration.loaded") {
        event.payload.model = settings.model;
        event.payload.execution_policy = structuredClone(executionPolicy);
      }
    }
  }
  const provenance: ExternalComparisonProvenance = {
    version: 1,
    reviewed_suite_id: "reviewed-refunds-v1",
    evaluator_version: "refund-evaluator-v2",
    scenarios: report.runs.map(({ report: run }, index) => {
      const task = run.trace.find(
        (event) => event.type === "user.task.received",
      )?.payload.task;
      return externalComparisonProvenanceSchema.shape.scenarios.element.parse({
        scenario_id: run.scenario_id,
        content_hash: String(index + 1).repeat(64),
        task_expectation: "complete",
        scenario: {
          id: run.scenario_id,
          name: run.scenario_name,
          seed: run.seed,
          user_task: task,
          mandate: structuredClone(run.mandate),
          initial_world: {
            payments: structuredClone(run.initial_world.payments),
          },
          faults: run.trace
            .filter((event) => event.type === "fault.injected")
            .map((event) => event.payload.fault),
          task_expectation: "complete",
        },
      });
    }),
    trials_per_scenario: 1,
    timeout_ms: 120_000,
    model_configuration: {
      provider: "openai",
      model: settings.model,
      execution: report.model_execution,
      verified: true,
      settings,
      execution_policy: executionPolicy,
    },
    trial_matrix: report.runs.map(({ report: run }) => ({
      scenario_id: run.scenario_id,
      run_number: run.run_number,
      task_expectation: "complete",
    })),
  };
  for (const scenario of provenance.scenarios)
    scenario.content_hash = hashScenario(scenario.scenario);
  report.provenance = provenance;
  return { report, provenance };
}

describe("saved external suite comparison", () => {
  it("compares changed application, prompt and tool hashes under matching conditions", async () => {
    const before = suite();
    const after = suite("after");
    after.report.application.contentHash = "f".repeat(64);
    for (const { report } of after.report.runs)
      for (const event of report.trace)
        if (event.type === "agent.configuration.loaded") {
          event.payload.prompt_hash = "changed-prompt";
          event.payload.tool_manifest_hash = "changed-tools";
        }
    const comparison = await compareExternalSuites(before.report, after.report);
    expect(comparison.directlyComparable).toBe(true);
    expect(comparison.compatibilityReasons).toEqual([]);
    expect(comparison.after.applicationHash).toBe("f".repeat(64));
    expect(comparison.after.promptHashes).toEqual(["changed-prompt"]);
    expect(comparison.after.toolManifestHashes).toEqual(["changed-tools"]);
    expect(comparison.before.legitimateCompletion).toEqual({
      passed: 2,
      total: 3,
    });
    expect(comparison.before.financialViolations).toBe(3);
    expect(comparison.scenarios).toHaveLength(3);
    expect(comparison.conclusion).toContain("do not prove");
  });

  it("compares normalized scenario contents independent of object key order", async () => {
    const before = suite();
    const after = suite("after");
    after.provenance.scenarios.reverse();
    after.provenance.trial_matrix.reverse();
    for (const scenario of after.provenance.scenarios) {
      scenario.scenario = Object.fromEntries(
        Object.entries(scenario.scenario).reverse(),
      ) as typeof scenario.scenario;
    }
    expect(
      (await compareExternalSuites(before.report, after.report))
        .directlyComparable,
    ).toBe(true);
  });

  it.each([
    [
      "evaluator version",
      (p: ExternalComparisonProvenance) => {
        p.evaluator_version = "other";
      },
    ],
    [
      "reviewed suite",
      (p: ExternalComparisonProvenance) => {
        p.reviewed_suite_id = "other";
      },
    ],
    [
      "trial count",
      (p: ExternalComparisonProvenance) => {
        p.trials_per_scenario = 2;
      },
    ],
    [
      "timeout",
      (p: ExternalComparisonProvenance) => {
        p.timeout_ms = 130_000;
      },
    ],
    [
      "model",
      (p: ExternalComparisonProvenance) => {
        p.model_configuration.model = "other";
      },
    ],
    [
      "unverified settings",
      (p: ExternalComparisonProvenance) => {
        p.model_configuration.verified = false;
      },
    ],
    [
      "missing settings",
      (p: ExternalComparisonProvenance) => {
        delete p.model_configuration.settings;
      },
    ],
    [
      "output cap",
      (p: ExternalComparisonProvenance) => {
        if (p.model_configuration.settings)
          p.model_configuration.settings.max_output_tokens = 100;
      },
    ],
    [
      "execution policy",
      (p: ExternalComparisonProvenance) => {
        if (p.model_configuration.execution_policy)
          p.model_configuration.execution_policy.max_turns = 3;
      },
    ],
    [
      "scenario content",
      (p: ExternalComparisonProvenance) => {
        const scenario = p.scenarios[0];
        if (scenario) scenario.scenario.user_task.amount += 1;
      },
    ],
    [
      "authority",
      (p: ExternalComparisonProvenance) => {
        const scenario = p.scenarios[0];
        if (scenario) scenario.scenario.mandate.maximum_amount += 1;
      },
    ],
    [
      "faults",
      (p: ExternalComparisonProvenance) => {
        const scenario = p.scenarios[0];
        if (scenario)
          scenario.scenario.faults = [
            {
              type: "timeout_before_side_effect",
              operation: "create_refund",
              occurrence: 1,
            },
          ];
      },
    ],
    [
      "scenario hash",
      (p: ExternalComparisonProvenance) => {
        const scenario = p.scenarios[0];
        if (scenario) scenario.content_hash = "0".repeat(64);
      },
    ],
    [
      "matrix expectation",
      (p: ExternalComparisonProvenance) => {
        const trial = p.trial_matrix[0];
        if (trial) trial.task_expectation = "refuse";
      },
    ],
  ])(
    "rejects mismatched %s while retaining observed outcomes",
    async (_label, mutate) => {
      const before = suite();
      const after = suite("after");
      mutate(after.provenance);
      const result = await compareExternalSuites(before.report, after.report);
      expect(result.directlyComparable).toBe(false);
      expect(result.compatibilityReasons.length).toBeGreaterThan(0);
      expect(result.after.totalTrials).toBe(3);
      expect(result.scenarios).toHaveLength(3);
    },
  );

  it("does not trust a verified flag without matching request telemetry", async () => {
    const before = suite();
    const after = suite("after");
    const event = after.report.runs[0]?.report.trace.find(
      (entry) => entry.type === "model.request.started",
    );
    if (!event) throw new Error("Missing fixture request");
    delete event.payload.settings;
    const result = await compareExternalSuites(before.report, after.report);
    expect(result.directlyComparable).toBe(false);
    expect(result.compatibilityReasons.join(" ")).toContain("telemetry");
  });

  it("rejects matching fabricated hashes instead of trusting their equality", async () => {
    const before = suite();
    const after = suite("after");
    for (const saved of [before, after]) {
      const scenario = saved.provenance.scenarios[0];
      if (!scenario) throw new Error("Missing fixture scenario");
      scenario.content_hash = "f".repeat(64);
    }
    const result = await compareExternalSuites(before.report, after.report);
    expect(result.directlyComparable).toBe(false);
    expect(result.compatibilityReasons.join(" ")).toContain("content hash");
    expect(result.after.totalTrials).toBe(3);
    expect(result.after.passedTrials).toBe(2);
  });

  it("checks the evaluator version and expectation actually recorded in each trial", async () => {
    const before = suite();
    const after = suite("after");
    const run = after.report.runs[0]?.report;
    if (!run) throw new Error("Missing fixture run");
    run.evaluator_version = "old-evaluator";
    expect(
      (await compareExternalSuites(before.report, after.report))
        .directlyComparable,
    ).toBe(false);
    run.evaluator_version = after.provenance.evaluator_version;
    delete run.task_expectation;
    const comparison = await compareExternalSuites(before.report, after.report);
    expect(comparison.directlyComparable).toBe(false);
    expect(comparison.after.legitimateCompletion).toBeNull();
  });

  it("includes additional actual provider settings in compatibility", async () => {
    const before = suite();
    const after = suite("after");
    const settings = after.provenance.model_configuration.settings;
    if (!settings) throw new Error("Missing fixture settings");
    settings.additional_parameters = { reasoning: { effort: "high" } };
    for (const { report } of after.report.runs)
      for (const event of report.trace)
        if (event.type === "model.request.started")
          event.payload.settings = structuredClone(settings);
    const result = await compareExternalSuites(before.report, after.report);
    expect(result.directlyComparable).toBe(false);
    expect(result.compatibilityReasons).toContain(
      "Model settings or execution policies differ.",
    );
  });

  it.each([undefined, { version: 999 }, { version: 1 }, "invalid"])(
    "keeps legacy or invalid provenance inspectable: %j",
    async (provenance) => {
      const before = suite();
      const after = suite("after");
      after.report.provenance = provenance;
      expect(externalSuiteReportSchema.safeParse(after.report).success).toBe(
        true,
      );
      const result = await compareExternalSuites(before.report, after.report);
      expect(result.directlyComparable).toBe(false);
      expect(result.after.legitimateCompletion).toBeNull();
      expect(result.after.passedTrials).toBe(2);
      expect(result.after.financialViolations).toBe(3);
    },
  );

  it("refuses incomplete trial matrices and different execution environments", async () => {
    const before = suite();
    const after = suite("after");
    after.report.runs.pop();
    after.report.model_execution =
      before.report.model_execution === "openai" ? "test_double" : "openai";
    const result = await compareExternalSuites(before.report, after.report);
    expect(result.directlyComparable).toBe(false);
    expect(result.compatibilityReasons.join(" ")).toContain("trial matrix");
    expect(result.compatibilityReasons.join(" ")).toContain(
      "environments differ",
    );
  });

  it("separates refusal trials and never counts execution errors as task completion", async () => {
    const before = suite();
    const after = suite("after");
    const scenario = after.provenance.scenarios[0];
    const trial = after.provenance.trial_matrix[0];
    const run = after.report.runs[2]?.report;
    if (!scenario || !trial || !run) throw new Error("Missing fixture trial");
    scenario.task_expectation = "refuse";
    scenario.scenario.task_expectation = "refuse";
    scenario.content_hash = hashScenario(scenario.scenario);
    trial.task_expectation = "refuse";
    const refusedRun = after.report.runs[0]?.report;
    if (!refusedRun) throw new Error("Missing refusal trial");
    refusedRun.task_expectation = "refuse";
    run.agent_error = { code: "APPLICATION_FAILED", message: "Failed" };
    run.final_claim_source = "eigen_failure_fallback";
    const result = await compareExternalSuites(before.report, after.report);
    expect(result.after.refusalCompletion).toEqual({ passed: 1, total: 1 });
    expect(result.after.legitimateCompletion).toEqual({ passed: 0, total: 2 });
    expect(result.after.executionErrors).toBe(1);
    expect(result.after.passedTrials).toBe(1);
  });

  it("does not imply that fewer violations improves legitimate completion", async () => {
    const before = suite();
    const after = suite("after");
    for (const { report } of after.report.runs) {
      report.findings = [];
      report.result = "fail";
      report.final_claim.status = "failed";
    }
    const result = await compareExternalSuites(before.report, after.report);
    expect(result.directlyComparable).toBe(true);
    expect(result.after.financialViolations).toBe(0);
    expect(result.after.legitimateCompletion).toEqual({ passed: 0, total: 3 });
    expect(result.conclusion).not.toMatch(/improved|safe|fixed/);
  });

  it("preserves the exact original reports and requires distinct suite selection", async () => {
    const before = suite();
    const original = structuredClone(before.report);
    expect(
      (await compareExternalSuites(before.report, before.report))
        .directlyComparable,
    ).toBe(false);
    expect(before.report).toEqual(original);
  });
});
