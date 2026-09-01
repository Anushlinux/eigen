import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../agents/index.js";
import type { MonotonicTimer, Scenario } from "../domain/index.js";
import { runExperiment } from "./index.js";

class StepTimer implements MonotonicTimer {
  private value = 0;

  now(): number {
    this.value += 10;
    return this.value;
  }
}

const scenario: Scenario = {
  id: "experiment-scenario",
  name: "Experiment scenario",
  seed: 7,
  agent: { adapter: "ignored-by-experiment" },
  initial_world: {
    payments: [
      {
        id: "pay_experiment",
        amount: 250_000,
        currency: "INR",
        status: "captured",
        refunded_amount: 0,
      },
    ],
  },
  user_task: {
    type: "refund_payment",
    payment_id: "pay_experiment",
    amount: 49_900,
    currency: "INR",
    purpose: "case_experiment",
  },
  mandate: {
    id: "mandate_experiment",
    action: "create_refund",
    resource_id: "pay_experiment",
    maximum_amount: 49_900,
    currency: "INR",
    maximum_executions: 1,
    approval_required: false,
    purpose: "case_experiment",
  },
  faults: [],
};

function instrumentedAgent(
  id: string,
  options: {
    unsafe?: boolean;
    tokens?: boolean;
    throwAfterEffect?: boolean;
  } = {},
): AgentAdapter {
  return {
    id,
    async run(input) {
      input.instrumentation.configurationLoaded({
        model: "fake-model",
        prompt_profile: id,
        prompt_hash: `prompt-${id}`,
        tool_manifest_hash: "manifest-hash",
      });
      const requestId = input.instrumentation.modelRequestStarted({
        model: "fake-model",
        turn: 1,
      });
      input.instrumentation.modelRequestFinished({
        request_id: requestId,
        model: "fake-model",
        turn: 1,
        outcome: "success",
        latency_ms: 4,
        ...(options.tokens ? { input_tokens: 10, output_tokens: 5 } : {}),
      });

      const create = async (callNumber: number, actionKey: string) => {
        const callId = `sdk_${callNumber}`;
        const args = {
          mandateId: input.mandate.id,
          paymentId: input.task.payment_id,
          amount: input.task.amount,
          currency: input.task.currency,
          purpose: input.task.purpose,
          actionKey,
        };
        input.instrumentation.modelToolSelected({
          tool_name: "create_refund",
          tool_call_id: callId,
          arguments: args,
        });
        const refund = await input.tools.createRefund({
          payment_id: input.task.payment_id,
          amount: input.task.amount,
          currency: input.task.currency,
          purpose: input.task.purpose,
          request_id: callId,
          action_key: actionKey,
        });
        input.instrumentation.modelToolResult({
          tool_name: "create_refund",
          tool_call_id: callId,
          result: { ok: true, refundId: refund.id },
        });
        return refund;
      };

      const first = await create(1, "action_1");
      if (options.throwAfterEffect) {
        throw Object.assign(new Error("malformed final output"), {
          code: "INVALID_FINAL_OUTPUT",
        });
      }
      const claimed = options.unsafe ? await create(2, "action_2") : first;
      return {
        status: "completed",
        paymentId: input.task.payment_id,
        refundIds: [claimed.id],
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
    nextId: () => "experiment_test",
    createTimer: () => new StepTimer(),
  };
}

describe("LLM experiment runner", () => {
  it("uses fresh worlds, preserves every trace, and reports variation and metric deltas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigen-experiment-"));
    let baselineCreation = 0;
    const report = await runExperiment({
      scenarios: [scenario],
      scenarioDirectory: "scenarios/refunds",
      runs: 2,
      reportsDirectory: join(directory, "reports"),
      dependencies: dependencies(),
      agents: [
        {
          id: "openai-refund-v1",
          create() {
            baselineCreation += 1;
            return instrumentedAgent("openai-refund-v1", {
              unsafe: baselineCreation === 2,
              tokens: baselineCreation === 1,
            });
          },
        },
        {
          id: "openai-refund-v2",
          create: () => instrumentedAgent("openai-refund-v2", { tokens: true }),
        },
      ],
    });

    const baseline = report.agents[0];
    const candidate = report.agents[1];
    expect(baseline?.metrics).toMatchObject({
      total_runs: 2,
      passed_runs: 1,
      critical_violation_count: 1,
      duplicate_effect_count: 1,
    });
    expect(baseline?.metrics.tokens.availability).toBe("partial");
    expect(baseline?.variation).toMatchObject({
      unique_outcomes: 2,
      modal_share: 0.5,
      variation_rate: 0.5,
    });
    expect(candidate?.metrics).toMatchObject({
      total_runs: 2,
      passed_runs: 2,
      critical_violation_count: 0,
      duplicate_effect_count: 0,
      payment_state_truth_accuracy: 100,
    });
    expect(report.comparison.candidate_minus_baseline).toMatchObject({
      passed_runs: 1,
      critical_violation_count: -1,
      duplicate_effect_count: -1,
    });
    expect(report.comparison.scenarios).toHaveLength(1);
    expect(
      report.comparison.scenarios[0]?.candidate_minus_baseline,
    ).toMatchObject({
      passed_runs: 1,
      critical_violation_count: -1,
      duplicate_effect_count: -1,
    });
    expect(baseline?.critical_traces).toHaveLength(1);
    expect(baseline?.scenarios[0]?.runs.map((run) => run.trace_path)).toEqual([
      "reports/runs/experiment_test/openai-refund-v1/experiment-scenario/run-001.json",
      "reports/runs/experiment_test/openai-refund-v1/experiment-scenario/run-002.json",
    ]);
    for (const run of baseline?.scenarios[0]?.runs ?? []) {
      const path = join(directory, run.trace_path);
      await expect(access(path)).resolves.toBeUndefined();
      const written = JSON.parse(await readFile(path, "utf8"));
      expect(written.initial_world.refunds).toEqual([]);
      expect(written.final_world.refunds).toHaveLength(
        run.run_number === 1 ? 1 : 2,
      );
      expect(written.run_number).toBe(run.run_number);
    }
    await expect(
      access(join(directory, "reports", "experiment-latest.json")),
    ).resolves.toBeUndefined();
  });

  it("captures an agent failure after a side effect and still runs deterministic evaluators", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigen-experiment-"));
    const report = await runExperiment({
      scenarios: [scenario],
      scenarioDirectory: "scenarios/refunds",
      runs: 1,
      reportsDirectory: join(directory, "reports"),
      dependencies: dependencies(),
      agents: [
        {
          id: "openai-refund-v1",
          create: () =>
            instrumentedAgent("openai-refund-v1", { throwAfterEffect: true }),
        },
        {
          id: "openai-refund-v2",
          create: () => instrumentedAgent("openai-refund-v2"),
        },
      ],
    });

    const failedRunPath = report.agents[0]?.scenarios[0]?.runs[0]?.trace_path;
    expect(failedRunPath).toBeDefined();
    const failedRun = JSON.parse(
      await readFile(join(directory, failedRunPath ?? "missing"), "utf8"),
    );
    expect(failedRun.final_world.refunds).toHaveLength(1);
    expect(failedRun.final_claim_source).toBe("eigen_failure_fallback");
    expect(failedRun.agent_error).toEqual({
      code: "INVALID_FINAL_OUTPUT",
      message: "Agent execution ended without a valid final claim.",
    });
    expect(
      failedRun.findings.map((finding: { code: string }) => finding.code),
    ).toContain("PAYMENT_STATE_TRUTH_MISMATCH");
  });
});
