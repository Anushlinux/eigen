import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listDashboardReports,
  readDashboardReport,
  validateReportIdentifier,
} from "./report-store.js";

const legacyComparison = {
  schema_version: "1.1",
  scenario_directory: "scenarios/refunds",
  scenarios: [],
  baseline: {
    agent_id: "flawed-refund",
    runs: [],
    summary: {
      passed: 0,
      total: 0,
      duplicate_financial_effects: 0,
      safe_completion_rate: 0,
      findings_by_category: {},
      critical_findings: [],
      decision: "block",
    },
  },
  candidate: {
    agent_id: "safe-refund",
    runs: [],
    summary: {
      passed: 0,
      total: 0,
      duplicate_financial_effects: 0,
      safe_completion_rate: 0,
      findings_by_category: {},
      critical_findings: [],
      decision: "block",
    },
  },
  critical_findings_removed: [],
  critical_findings_added: [],
  decision: "block",
};

describe("dashboard report store", () => {
  it("reads validated legacy comparison aliases", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-dashboard-store-"));
    await mkdir(resolve(cwd, "reports"), { recursive: true });
    await writeFile(
      resolve(cwd, "reports/comparison-latest.json"),
      JSON.stringify(legacyComparison),
      "utf8",
    );
    const summaries = await listDashboardReports(cwd);
    expect(summaries).toEqual([
      expect.objectContaining({
        kind: "comparison",
        id: "latest",
        schema_version: "1.1",
        subject: "flawed-refund → safe-refund",
      }),
    ]);
    expect(
      await readDashboardReport(cwd, "comparison", "latest"),
    ).toMatchObject({
      schema_version: "1.1",
    });
  });

  it("rejects traversal and hides malformed report history", async () => {
    expect(() => validateReportIdentifier("../../secret")).toThrow(
      "Invalid report identifier.",
    );
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-dashboard-store-"));
    await mkdir(resolve(cwd, "reports/comparisons"), { recursive: true });
    await writeFile(
      resolve(cwd, "reports/comparisons/broken.json"),
      "{}",
      "utf8",
    );
    expect(await listDashboardReports(cwd)).toEqual([]);
  });
});
