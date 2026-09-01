import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentAdapter, MonotonicTimer } from "@eigen/core";
import { describe, expect, it } from "vitest";
import {
  type ExperimentCommandDependencies,
  experimentCommand,
} from "./commands/experiment.js";

class StepTimer implements MonotonicTimer {
  private value = 0;

  now(): number {
    this.value += 1;
    return this.value;
  }
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout(message: string) {
        stdout.push(message);
      },
      stderr(message: string) {
        stderr.push(message);
      },
    },
  };
}

function agent(id: string): AgentAdapter {
  return {
    id,
    async run(input) {
      input.instrumentation.configurationLoaded({
        model: "fake-model",
        prompt_profile: id,
        prompt_hash: `hash-${id}`,
        tool_manifest_hash: "manifest",
      });
      const refund = await input.tools.createRefund({
        payment_id: input.task.payment_id,
        amount: input.task.amount,
        currency: input.task.currency,
        purpose: input.task.purpose,
        request_id: "request_1",
        action_key: "action_1",
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

function failingAgent(id: string): AgentAdapter {
  return {
    id,
    async run(input) {
      input.instrumentation.configurationLoaded({
        model: "fake-model",
        prompt_profile: id,
        prompt_hash: `hash-${id}`,
        tool_manifest_hash: "manifest",
      });
      return {
        status: "failed",
        paymentId: input.task.payment_id,
        refundIds: [],
        amount: input.task.amount,
        currency: input.task.currency,
        message: "Refund failed.",
      };
    },
  };
}

function dependencies(
  apiKey = "sk-test-secret",
): ExperimentCommandDependencies {
  return {
    environment: {
      OPENAI_API_KEY: apiKey,
      OPENAI_MODEL: "fake-model",
    },
    createAgent(profileId) {
      return profileId === "openai-refund-v1"
        ? failingAgent(profileId)
        : agent(profileId);
    },
    now: () => "2026-09-01T00:00:00.000Z",
    nextId: () => "experiment_cli",
    createTimer: () => new StepTimer(),
  };
}

const scenarioDirectory = resolve(process.cwd(), "scenarios/refunds");

describe("experiment CLI command", () => {
  it("returns 1 for observed critical failures and 0 only when explicitly allowed", async () => {
    const firstCwd = await mkdtemp(join(tmpdir(), "eigen-cli-experiment-"));
    const firstCapture = captureIo();
    const first = await experimentCommand(
      {
        scenarioDirectory,
        agentNames: "openai-refund-v1,openai-refund-v2",
        runs: "1",
        allowFailures: false,
        cwd: firstCwd,
        io: firstCapture.io,
      },
      dependencies(),
    );
    expect(first.exitCode).toBe(1);
    expect(firstCapture.stdout.join("\n")).toContain("EIGEN LLM EXPERIMENT");
    expect(firstCapture.stdout.join("\n")).toContain(
      "Decision:                     BLOCK",
    );

    const secondCwd = await mkdtemp(join(tmpdir(), "eigen-cli-experiment-"));
    const secondCapture = captureIo();
    const second = await experimentCommand(
      {
        scenarioDirectory,
        agentNames: "openai-refund-v1,openai-refund-v2",
        runs: "1",
        allowFailures: true,
        cwd: secondCwd,
        io: secondCapture.io,
      },
      dependencies(),
    );
    expect(second.exitCode).toBe(0);
    const aggregate = await readFile(
      join(secondCwd, "reports", "experiment-latest.json"),
      "utf8",
    );
    expect(aggregate).not.toContain("sk-test-secret");
  });

  it("returns 1 for missing configuration or invalid command values without a network request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eigen-cli-experiment-"));
    const missingCapture = captureIo();
    const missing = await experimentCommand(
      {
        scenarioDirectory,
        agentNames: "openai-refund-v1,openai-refund-v2",
        runs: "1",
        allowFailures: false,
        cwd,
        io: missingCapture.io,
      },
      dependencies(""),
    );
    expect(missing.exitCode).toBe(1);
    expect(missingCapture.stderr.join("\n")).toContain(
      "OPENAI_API_KEY is required",
    );

    const invalidCapture = captureIo();
    const invalid = await experimentCommand(
      {
        scenarioDirectory,
        agentNames: "openai-refund-v1,openai-refund-v1",
        runs: "0",
        allowFailures: false,
        cwd,
        io: invalidCapture.io,
      },
      dependencies(),
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalidCapture.stderr.join("\n")).toContain("duplicate profiles");
  });
});
