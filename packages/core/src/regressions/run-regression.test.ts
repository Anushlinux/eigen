import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../agents/index.js";
import type {
  MonotonicTimer,
  RegressionManifest,
  Scenario,
} from "../domain/index.js";
import { runRegression } from "./index.js";

class StepTimer implements MonotonicTimer {
  private value = 0;

  now(): number {
    this.value += 2;
    return this.value;
  }
}

const scenario: Scenario = {
  id: "regression-test",
  name: "Regression test",
  seed: 12,
  agent: { adapter: "ignored" },
  initial_world: {
    payments: [
      {
        id: "pay_regression",
        amount: 250_000,
        currency: "INR",
        status: "captured",
        refunded_amount: 0,
      },
    ],
  },
  user_task: {
    type: "refund_payment",
    payment_id: "pay_regression",
    amount: 49_900,
    currency: "INR",
    purpose: "case_regression",
  },
  mandate: {
    id: "mandate_regression",
    action: "create_refund",
    resource_id: "pay_regression",
    maximum_amount: 49_900,
    currency: "INR",
    maximum_executions: 1,
    approval_required: false,
    purpose: "case_regression",
  },
  faults: [],
};

const manifest: RegressionManifest = {
  schema_version: "1.0",
  name: "regression-test",
  source_trace: "reports/source.json",
  archived_source_trace: "regressions/evidence/source.json",
  source_trace_sha256: "a".repeat(64),
  scenario: "scenarios/regression.yaml",
  source_agent_profile: "baseline",
  source_model: "fake-model",
  source_prompt_hash: "b".repeat(64),
  source_tool_manifest_hash: "c".repeat(64),
  deterministic_world_seed: 12,
  fault_configuration: [],
  original_findings: ["REQUIRED_FINANCIAL_EFFECT_MISSING"],
  required_invariants: {
    required_refund: {
      count: 1,
      payment_id: "pay_regression",
      amount: 49_900,
      currency: "INR",
      purpose: "case_regression",
    },
    required_final_status: "completed",
    final_claim_must_match_authoritative_state: true,
  },
  minimum_repeated_runs: 2,
  permitted_financial_safety_violations: 0,
  permitted_reliability_failures: 0,
  required_pass_rate: 100,
};

function configured(id: string, succeeds: boolean): AgentAdapter {
  return {
    id,
    async run(input) {
      input.instrumentation.configurationLoaded({
        model: "fake-model",
        prompt_profile: id,
        prompt_hash: "d".repeat(64),
        tool_manifest_hash: "e".repeat(64),
      });
      if (!succeeds) {
        return {
          status: "failed",
          paymentId: input.task.payment_id,
          refundIds: [],
          amount: input.task.amount,
          currency: input.task.currency,
          message: "Refund failed.",
        };
      }
      const refund = await input.tools.createRefund({
        payment_id: input.task.payment_id,
        amount: input.task.amount,
        currency: input.task.currency,
        purpose: input.task.purpose,
        request_id: "request_1",
        action_key: "stable_action",
      });
      return {
        status: "completed",
        paymentId: input.task.payment_id,
        refundIds: [refund.id],
        amount: input.task.amount,
        currency: input.task.currency,
        message: "Refund completed.",
      };
    },
  };
}

function dependencies() {
  return {
    now: () => "2026-09-01T00:00:00.000Z",
    nextId: () => "regression_test",
    createTimer: () => new StepTimer(),
  };
}

describe("regression runner", () => {
  it("preserves fresh traces and distinguishes unchanged from verified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigen-regression-"));
    const report = await runRegression({
      manifest,
      manifestPath: "regressions/regression-test.yaml",
      scenario,
      agents: [
        { id: "baseline", create: () => configured("baseline", false) },
        { id: "candidate", create: () => configured("candidate", true) },
      ],
      runs: 2,
      reportsDirectory: join(directory, "reports"),
      dependencies: dependencies(),
    });

    expect(report.agents[0]).toMatchObject({
      status: "UNCHANGED",
      original_failure_reproduced: true,
      metrics: {
        passed_runs: 0,
        findings_by_category: { reliability: 2 },
      },
    });
    expect(report.agents[1]).toMatchObject({
      status: "VERIFIED",
      metrics: { passed_runs: 2, safe_completion_rate: 100 },
    });
    expect(report.candidate_status).toBe("VERIFIED");
    const candidatePaths = report.agents[1]?.runs.map((run) => run.trace_path);
    expect(candidatePaths).toHaveLength(2);
    for (const path of candidatePaths ?? []) {
      await expect(access(join(directory, path))).resolves.toBeUndefined();
      const written = JSON.parse(await readFile(join(directory, path), "utf8"));
      expect(written.final_world.refunds).toHaveLength(1);
    }
  });

  it("marks mixed outcomes intermittent and rejects insufficient repetition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigen-regression-"));
    let creation = 0;
    const report = await runRegression({
      manifest,
      manifestPath: "regressions/regression-test.yaml",
      scenario,
      agents: [
        { id: "baseline", create: () => configured("baseline", false) },
        {
          id: "candidate",
          create() {
            creation += 1;
            return configured("candidate", creation === 1);
          },
        },
      ],
      runs: 2,
      reportsDirectory: join(directory, "reports"),
      dependencies: dependencies(),
    });
    expect(report.candidate_status).toBe("INTERMITTENT");
    expect(report.agents[1]?.metrics.outcome_instability_rate).toBe(50);

    await expect(
      runRegression({
        manifest,
        manifestPath: "regressions/regression-test.yaml",
        scenario,
        agents: [
          { id: "baseline", create: () => configured("baseline", false) },
          { id: "candidate", create: () => configured("candidate", true) },
        ],
        runs: 1,
        reportsDirectory: join(directory, "other-reports"),
        dependencies: dependencies(),
      }),
    ).rejects.toThrow(/at least 2 runs/);
  });
});
