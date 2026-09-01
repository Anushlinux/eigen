import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDemo } from "./demo.js";
import { main } from "./index.js";

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

const scenarioPath = resolve(
  process.cwd(),
  "scenarios/refund-timeout-duplicate.yaml",
);
const scenarioDirectory = resolve(process.cwd(), "scenarios/refunds");

describe("CLI", () => {
  it("returns 1 for the evaluated unsafe run and writes its report", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-cli-"));
    const capture = captureIo();
    const exitCode = await main(
      ["node", "eigen", "run", scenarioPath, "--agent", "flawed-refund"],
      cwd,
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stdout.join("\n")).toContain("Result     FAIL");
    const reportPath = resolve(cwd, "reports", "latest.json");
    await expect(access(reportPath)).resolves.toBeUndefined();
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.summary.total_refunded).toBe(99_800);
  });

  it("returns 2 for an unknown agent", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-cli-"));
    const capture = captureIo();
    const exitCode = await main(
      ["node", "eigen", "run", scenarioPath, "--agent", "unknown"],
      cwd,
      capture.io,
    );
    expect(exitCode).toBe(2);
    expect(capture.stderr.join("\n")).toContain("Unknown agent");
  });

  it("compares baseline and candidate and writes the full report", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-compare-"));
    const capture = captureIo();
    const exitCode = await main(
      [
        "node",
        "eigen",
        "compare",
        scenarioDirectory,
        "--baseline",
        "flawed-refund",
        "--candidate",
        "safe-refund",
      ],
      cwd,
      capture.io,
    );

    expect(exitCode).toBe(0);
    const terminal = capture.stdout.join("\n");
    expect(terminal).toContain("baseline=FAIL  candidate=PASS");
    expect(terminal).toContain("Duplicate financial effects: 1");
    expect(terminal).toContain("Safe completion rate: 100%");
    const reportPath = resolve(cwd, "reports", "comparison-latest.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.baseline.runs).toHaveLength(3);
    expect(report.candidate.runs).toHaveLength(3);
    expect(report.candidate.summary.decision).toBe("pass");
  });

  it("returns 1 when the candidate has a critical financial failure", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-compare-"));
    const capture = captureIo();
    const exitCode = await main(
      [
        "node",
        "eigen",
        "compare",
        scenarioDirectory,
        "--baseline",
        "safe-refund",
        "--candidate",
        "flawed-refund",
      ],
      cwd,
      capture.io,
    );
    expect(exitCode).toBe(1);
    expect(capture.stdout.join("\n")).toContain("Candidate: flawed-refund");
    expect(capture.stdout.join("\n")).toContain("Decision: BLOCK");
  });

  it("returns 0 when the demo detects its expected unsafe outcome", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-demo-"));
    const capture = captureIo();
    const exitCode = await runDemo(cwd, scenarioPath, capture.io);
    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("Demo assertion passed");
  });

  it("returns 1 when required experiment configuration is missing", async () => {
    const capture = captureIo();
    const exitCode = await main(
      ["node", "eigen", "experiment", scenarioDirectory],
      process.cwd(),
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stderr.join("\n")).toContain("required option");
  });
});
