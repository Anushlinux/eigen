import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MonotonicTimer, RegressionReport } from "@eigen/core";
import { OpenAIRefundAgent } from "@eigen/openai-adapter";
import type { Model, ModelProvider } from "@openai/agents";
import {
  assistantMessage,
  functionCall,
  ScriptedModel,
} from "@openai/agents/testing";
import { regressCommand } from "./commands/regress.js";

class FakeModelProvider implements ModelProvider {
  constructor(private readonly model: Model) {}

  getModel(): Model {
    return this.model;
  }
}

class StepTimer implements MonotonicTimer {
  private value = 0;

  now(): number {
    this.value += 5;
    return this.value;
  }
}

const stableActionKey =
  "mandate_refund_before:create_refund:pay_refund_before:support_case_before";

function createRefund(callId: string) {
  return functionCall(
    "create_refund",
    {
      mandateId: "mandate_refund_before",
      paymentId: "pay_refund_before",
      amount: 49_900,
      currency: "INR",
      purpose: "support_case_before",
      actionKey: stableActionKey,
    },
    { callId },
  );
}

function fetchRefunds(callId: string) {
  return functionCall(
    "fetch_refunds_for_payment",
    { paymentId: "pay_refund_before" },
    { callId },
  );
}

function v2Model(): Model {
  return new ScriptedModel([
    [createRefund("v2_create_1")],
    [fetchRefunds("v2_fetch_1")],
    [
      assistantMessage(
        JSON.stringify({
          status: "unknown",
          paymentId: "pay_refund_before",
          refundIds: [],
          amount: 49_900,
          currency: "INR",
          message:
            "Refund outcome is unknown; no authoritative refund is recorded.",
        }),
      ),
    ],
  ]);
}

function v3Model(): Model {
  return new ScriptedModel([
    [createRefund("v3_create_1")],
    [fetchRefunds("v3_fetch_1")],
    [createRefund("v3_create_2")],
    [fetchRefunds("v3_fetch_2")],
    [
      assistantMessage(
        JSON.stringify({
          status: "completed",
          paymentId: "pay_refund_before",
          refundIds: ["refund_2v_001"],
          amount: 49_900,
          currency: "INR",
          message: "The authoritative refund state confirms completion.",
        }),
      ),
    ],
  ]);
}

export async function runRegressionDemo(cwd = process.cwd()): Promise<number> {
  const outcome = await regressCommand(
    {
      manifestPath:
        "regressions/refund-timeout-before-side-effect-live-001.yaml",
      agentNames: "openai-refund-v2,openai-refund-v3",
      runs: "10",
      cwd,
      io: {
        stdout(message) {
          process.stdout.write(`${message}\n`);
        },
        stderr(message) {
          process.stderr.write(`${message}\n`);
        },
      },
    },
    {
      environment: {
        OPENAI_API_KEY: "sk-fake-regression-demo",
        OPENAI_MODEL: "fake-scripted-model",
      },
      createAgent(profileId) {
        const model = profileId === "openai-refund-v2" ? v2Model() : v3Model();
        return new OpenAIRefundAgent({
          profileId:
            profileId === "openai-refund-v2"
              ? "openai-refund-v2"
              : "openai-refund-v3",
          model: "fake-scripted-model",
          modelProvider: new FakeModelProvider(model),
          timer: new StepTimer(),
          tracingEnabled: false,
        });
      },
      now: () => "2026-09-01T00:00:00.000Z",
      nextId: () => "regression_demo",
      createTimer: () => new StepTimer(),
    },
  );
  if (outcome.exitCode !== 0) return outcome.exitCode;

  const report = JSON.parse(
    await readFile(resolve(cwd, "reports", "regression-latest.json"), "utf8"),
  ) as RegressionReport;
  const baseline = report.agents.find(
    (agent) => agent.agent_id === "openai-refund-v2",
  );
  const candidate = report.agents.find(
    (agent) => agent.agent_id === "openai-refund-v3",
  );
  const confirmed =
    baseline?.status === "UNCHANGED" &&
    baseline.metrics.findings_by_category.reliability === 10 &&
    baseline.metrics.findings_by_category.calibration === 10 &&
    candidate?.status === "VERIFIED" &&
    candidate.metrics.passed_runs === 10 &&
    candidate.metrics.recovery_success_rate === 100;
  if (!confirmed) {
    process.stderr.write(
      "Regression demo assertion failed: v2 failure or v3 fix was not confirmed.\n",
    );
    return 1;
  }
  process.stdout.write(
    "Regression demo assertion passed: v2 reproduced the failure and v3 is VERIFIED.\n",
  );
  return 0;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isDirectExecution) process.exitCode = await runRegressionDemo();
