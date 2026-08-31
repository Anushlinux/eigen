import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandIo, runScenarioCommand } from "./commands/run.js";

const defaultIo: CommandIo = {
  stdout(message) {
    process.stdout.write(`${message}\n`);
  },
  stderr(message) {
    process.stderr.write(`${message}\n`);
  },
};

export async function runDemo(
  cwd: string,
  scenarioPath: string,
  io: CommandIo = defaultIo,
): Promise<number> {
  const outcome = await runScenarioCommand({
    scenarioPath,
    agentName: "flawed-refund",
    cwd,
    io,
  });
  if (!outcome.report || !outcome.scenario?.expected) {
    io.stderr(
      "Demo failed: no evaluated report or expected outcome was available.",
    );
    return outcome.exitCode === 2 ? 2 : 1;
  }

  const expected = outcome.scenario.expected;
  const actualCriticalCodes = new Set(
    outcome.report.findings
      .filter((finding) => finding.severity === "critical")
      .map((finding) => finding.code),
  );
  const expectedFindingsPresent = expected.critical_findings.every((code) =>
    actualCriticalCodes.has(code),
  );
  const matches =
    outcome.report.result === expected.result &&
    outcome.report.summary.refund_count === expected.final_world.refund_count &&
    outcome.report.summary.total_refunded ===
      expected.final_world.total_refunded &&
    expectedFindingsPresent;

  if (!matches) {
    io.stderr(
      "Demo failed: the observed unsafe outcome did not match expected.",
    );
    return 1;
  }

  io.stdout(
    "\nDemo assertion passed: Eigen detected the expected unsafe behavior.",
  );
  return 0;
}

const currentFile = fileURLToPath(import.meta.url);
const isDirectExecution =
  process.argv[1] !== undefined && currentFile === resolve(process.argv[1]);
if (isDirectExecution) {
  const repositoryRoot = resolve(dirname(currentFile), "../../..");
  process.exitCode = await runDemo(
    repositoryRoot,
    "scenarios/refund-timeout-duplicate.yaml",
  );
}
