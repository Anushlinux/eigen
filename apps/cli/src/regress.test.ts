import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentAdapter, MonotonicTimer } from "@eigen/core";
import { describe, expect, it } from "vitest";
import {
  type RegressionCommandDependencies,
  regressCommand,
} from "./commands/regress.js";

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

function regressionAgent(id: string, recover: boolean): AgentAdapter {
  return {
    id,
    async run(input) {
      input.instrumentation.configurationLoaded({
        model: "fake-model",
        prompt_profile: id,
        prompt_hash: "a".repeat(64),
        tool_manifest_hash: "b".repeat(64),
      });
      const actionKey = "stable_action";
      try {
        await input.tools.createRefund({
          payment_id: input.task.payment_id,
          amount: input.task.amount,
          currency: input.task.currency,
          purpose: input.task.purpose,
          request_id: "request_1",
          action_key: actionKey,
        });
      } catch {
        const existing = await input.tools.fetchRefundsForPayment({
          payment_id: input.task.payment_id,
          semantic_action_key: actionKey,
        });
        if (!recover) {
          return {
            status: "unknown",
            paymentId: input.task.payment_id,
            refundIds: [],
            amount: input.task.amount,
            currency: input.task.currency,
            message: "Refund outcome unknown.",
          };
        }
        if (existing.length === 0) {
          await input.tools.createRefund({
            payment_id: input.task.payment_id,
            amount: input.task.amount,
            currency: input.task.currency,
            purpose: input.task.purpose,
            request_id: "request_2",
            action_key: actionKey,
          });
        }
      }
      const refunds = await input.tools.fetchRefundsForPayment({
        payment_id: input.task.payment_id,
        semantic_action_key: actionKey,
      });
      return {
        status: "completed",
        paymentId: input.task.payment_id,
        refundIds: refunds.map((refund) => refund.id),
        amount: input.task.amount,
        currency: input.task.currency,
        message: "Refund completed.",
      };
    },
  };
}

function dependencies(candidateRecovers = true): RegressionCommandDependencies {
  return {
    environment: {
      OPENAI_API_KEY: "sk-test-secret",
      OPENAI_MODEL: "fake-model",
    },
    createAgent(profileId) {
      return regressionAgent(
        profileId,
        profileId === "openai-refund-v3" && candidateRecovers,
      );
    },
    now: () => "2026-09-01T00:00:00.000Z",
    nextId: () => "regression_cli",
    createTimer: () => new StepTimer(),
  };
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "eigen-regress-cli-"));
  const repository = process.cwd();
  const manifestPath =
    "regressions/refund-timeout-before-side-effect-live-001.yaml";
  const evidencePath =
    "regressions/evidence/refund-timeout-before-side-effect-live-001.json";
  const scenarioPath = "scenarios/refunds/03-timeout-before-side-effect.yaml";
  for (const path of [manifestPath, evidencePath, scenarioPath]) {
    await mkdir(resolve(cwd, path, ".."), { recursive: true });
    await writeFile(
      resolve(cwd, path),
      await readFile(resolve(repository, path)),
    );
  }
  return { cwd, manifestPath, evidencePath };
}

describe("regress command", () => {
  it("returns success only for a verified candidate and does not leak secrets", async () => {
    const { cwd, manifestPath } = await fixture();
    const capture = captureIo();
    const outcome = await regressCommand(
      {
        manifestPath,
        agentNames: "openai-refund-v2,openai-refund-v3",
        runs: "10",
        cwd,
        io: capture.io,
      },
      dependencies(),
    );
    expect(outcome.exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("Candidate result: VERIFIED");
    const aggregate = await readFile(
      resolve(cwd, "reports", "regression-latest.json"),
      "utf8",
    );
    expect(aggregate).not.toContain("sk-test-secret");

    const failedCandidate = await regressCommand(
      {
        manifestPath,
        agentNames: "openai-refund-v2,openai-refund-v3",
        runs: "10",
        cwd,
        io: captureIo().io,
      },
      dependencies(false),
    );
    expect(failedCandidate.exitCode).toBe(1);
  });

  it("returns invalid-input status for insufficient runs and altered evidence", async () => {
    const { cwd, manifestPath, evidencePath } = await fixture();
    const insufficient = await regressCommand(
      {
        manifestPath,
        agentNames: "openai-refund-v2,openai-refund-v3",
        runs: "9",
        cwd,
        io: captureIo().io,
      },
      dependencies(),
    );
    expect(insufficient.exitCode).toBe(2);

    await writeFile(resolve(cwd, evidencePath), "altered evidence\n");
    const corrupted = await regressCommand(
      {
        manifestPath,
        agentNames: "openai-refund-v2,openai-refund-v3",
        runs: "10",
        cwd,
        io: captureIo().io,
      },
      dependencies(),
    );
    expect(corrupted.exitCode).toBe(2);
  });
});
