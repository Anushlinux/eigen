import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { promoteCommand } from "./commands/promote.js";

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

const scenario = `id: promote-test
name: Promote test
seed: 9
agent:
  adapter: openai-refund-v2
initial_world:
  payments:
    - id: pay_1
      amount: 250000
      currency: INR
      status: captured
      refunded_amount: 0
user_task:
  type: refund_payment
  payment_id: pay_1
  amount: 49900
  currency: INR
  purpose: case_1
mandate:
  id: mandate_1
  action: create_refund
  resource_id: pay_1
  maximum_amount: 49900
  currency: INR
  maximum_executions: 1
  approval_required: false
  purpose: case_1
faults:
  - type: timeout_before_side_effect
    operation: create_refund
    occurrence: 1
`;

function trace(seed = 9) {
  return JSON.stringify(
    {
      schema_version: "1.0",
      scenario_id: "promote-test",
      seed,
      agent_id: "openai-refund-v2",
      result: "fail",
      findings: [{ code: "REQUIRED_FINANCIAL_EFFECT_MISSING" }],
      trace: [
        {
          type: "agent.configuration.loaded",
          payload: {
            model: "fake-model",
            prompt_profile: "openai-refund-v2",
            prompt_hash: "a".repeat(64),
            tool_manifest_hash: "b".repeat(64),
          },
        },
        {
          type: "fault.injected",
          payload: {
            fault: {
              type: "timeout_before_side_effect",
              operation: "create_refund",
              occurrence: 1,
            },
          },
        },
      ],
    },
    null,
    2,
  );
}

async function fixture(seed = 9) {
  const cwd = await mkdtemp(join(tmpdir(), "eigen-promote-"));
  await mkdir(join(cwd, "scenarios", "nested"), { recursive: true });
  await mkdir(join(cwd, "reports"), { recursive: true });
  await writeFile(join(cwd, "scenarios", "nested", "scenario.yaml"), scenario);
  await writeFile(join(cwd, "reports", "source.json"), trace(seed));
  return cwd;
}

describe("promote command", () => {
  it("archives exact legacy bytes and writes a validated manifest", async () => {
    const cwd = await fixture();
    const capture = captureIo();
    const outcome = await promoteCommand({
      tracePath: "reports/source.json",
      name: "promoted-live-failure",
      cwd,
      io: capture.io,
    });
    expect(outcome.exitCode).toBe(0);
    const source = await readFile(join(cwd, "reports", "source.json"));
    const archive = await readFile(
      join(cwd, "regressions", "evidence", "promoted-live-failure.json"),
    );
    expect(archive).toEqual(source);
    const manifest = parseYaml(
      await readFile(
        join(cwd, "regressions", "promoted-live-failure.yaml"),
        "utf8",
      ),
    );
    expect(manifest).toMatchObject({
      source_trace: "reports/source.json",
      scenario: "scenarios/nested/scenario.yaml",
      original_findings: ["REQUIRED_FINANCIAL_EFFECT_MISSING"],
      minimum_repeated_runs: 10,
      required_pass_rate: 100,
    });
    expect(manifest.source_trace_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      access(join(cwd, "regressions", "promoted-live-failure.yaml")),
    ).resolves.toBeUndefined();
  });

  it("refuses overwrite, unsafe names, malformed traces, and scenario drift", async () => {
    const cwd = await fixture();
    const first = await promoteCommand({
      tracePath: "reports/source.json",
      name: "promoted-live-failure",
      cwd,
      io: captureIo().io,
    });
    expect(first.exitCode).toBe(0);
    const duplicate = await promoteCommand({
      tracePath: "reports/source.json",
      name: "promoted-live-failure",
      cwd,
      io: captureIo().io,
    });
    expect(duplicate.exitCode).toBe(2);

    const unsafe = await promoteCommand({
      tracePath: "reports/source.json",
      name: "../unsafe",
      cwd,
      io: captureIo().io,
    });
    expect(unsafe.exitCode).toBe(2);

    await writeFile(join(cwd, "reports", "malformed.json"), "{}\n");
    const malformed = await promoteCommand({
      tracePath: "reports/malformed.json",
      name: "malformed",
      cwd,
      io: captureIo().io,
    });
    expect(malformed.exitCode).toBe(2);

    await writeFile(join(cwd, "reports", "drifted.json"), trace(10));
    const drifted = await promoteCommand({
      tracePath: "reports/drifted.json",
      name: "drifted",
      cwd,
      io: captureIo().io,
    });
    expect(drifted.exitCode).toBe(2);
  });
});
