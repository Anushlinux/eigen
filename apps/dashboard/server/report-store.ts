import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

export type DashboardReportKind = "comparison" | "smoke";

export interface DashboardReportSummary {
  kind: DashboardReportKind;
  id: string;
  created_at: string | null;
  decision: "allow" | "block";
  subject: string;
  schema_version: string;
}

const identifierPattern = /^[A-Za-z0-9_-]+$/;
const runReportSchema = z
  .object({
    run_id: z.string(),
    scenario_id: z.string(),
    agent_id: z.string(),
    trace: z.array(z.unknown()),
    findings: z.array(z.unknown()),
    final_world: z.object({ refunds: z.array(z.unknown()) }).passthrough(),
    final_claim: z.object({ status: z.string() }).passthrough(),
    result: z.enum(["pass", "fail"]),
    deployment_decision: z.enum(["allow", "block"]),
  })
  .passthrough();

const comparisonAgentSchema = z.object({
  agent_id: z.string(),
  runs: z.array(runReportSchema),
  summary: z.object({
    passed: z.number(),
    total: z.number(),
    duplicate_financial_effects: z.number(),
    safe_completion_rate: z.number(),
    findings_by_category: z.record(z.string(), z.number()),
    critical_findings: z.array(z.unknown()),
    decision: z.enum(["pass", "block"]),
  }),
});

const comparisonReportSchema = z
  .object({
    schema_version: z.enum(["1.1", "1.2"]),
    comparison_id: z.string().optional(),
    created_at: z.string().optional(),
    scenario_directory: z.string(),
    scenarios: z.array(
      z.object({
        scenario_id: z.string(),
        scenario_name: z.string(),
        seed: z.number(),
        baseline_result: z.enum(["pass", "fail"]),
        candidate_result: z.enum(["pass", "fail"]),
      }),
    ),
    baseline: comparisonAgentSchema,
    candidate: comparisonAgentSchema,
    critical_findings_removed: z.array(z.unknown()),
    critical_findings_added: z.array(z.unknown()),
    decision: z.enum(["pass", "block"]),
  })
  .passthrough();

const smokeReportSchema = z
  .object({
    schema_version: z.enum(["1.0", "1.1"]),
    created_at: z.string(),
    run_id: z.string(),
    agent_id: z.string(),
    payment_id: z.string(),
    result: z.enum(["pass", "fail"]),
    deployment_decision: z.enum(["allow", "block"]),
  })
  .passthrough();

function parseReport(kind: DashboardReportKind, value: unknown): unknown {
  return kind === "comparison"
    ? comparisonReportSchema.parse(value)
    : smokeReportSchema.parse(value);
}

function reportDirectory(cwd: string, kind: DashboardReportKind): string {
  return resolve(
    cwd,
    "reports",
    kind === "comparison" ? "comparisons" : "razorpay-smoke",
  );
}

function latestPath(cwd: string, kind: DashboardReportKind): string {
  return resolve(
    cwd,
    "reports",
    kind === "comparison"
      ? "comparison-latest.json"
      : "razorpay-smoke-latest.json",
  );
}

async function readValidated(
  path: string,
  kind: DashboardReportKind,
): Promise<unknown> {
  const source = await readFile(path, "utf8");
  return parseReport(kind, JSON.parse(source) as unknown);
}

function summaryFor(
  kind: DashboardReportKind,
  id: string,
  value: unknown,
): DashboardReportSummary {
  if (kind === "comparison") {
    const report = comparisonReportSchema.parse(value);
    return {
      kind,
      id,
      created_at: report.created_at ?? null,
      decision: report.decision === "pass" ? "allow" : "block",
      subject: `${report.baseline.agent_id} → ${report.candidate.agent_id}`,
      schema_version: report.schema_version,
    };
  }
  const report = smokeReportSchema.parse(value);
  return {
    kind,
    id,
    created_at: report.created_at,
    decision: report.deployment_decision,
    subject: report.payment_id,
    schema_version: report.schema_version,
  };
}

export function validateReportIdentifier(id: string): void {
  if (!identifierPattern.test(id)) {
    throw new Error("Invalid report identifier.");
  }
}

export async function readDashboardReport(
  cwd: string,
  kind: DashboardReportKind,
  id: string,
): Promise<unknown> {
  validateReportIdentifier(id);
  const path =
    id === "latest"
      ? latestPath(cwd, kind)
      : resolve(reportDirectory(cwd, kind), `${id}.json`);
  if (id !== "latest" && basename(path) !== `${id}.json`) {
    throw new Error("Invalid report identifier.");
  }
  return readValidated(path, kind);
}

export async function listDashboardReports(
  cwd: string,
): Promise<DashboardReportSummary[]> {
  const summaries: DashboardReportSummary[] = [];
  for (const kind of ["comparison", "smoke"] as const) {
    let files: string[] = [];
    try {
      files = (await readdir(reportDirectory(cwd, kind)))
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch {
      files = [];
    }
    for (const file of files) {
      const id = file.slice(0, -5);
      if (!identifierPattern.test(id)) continue;
      try {
        const report = await readValidated(
          resolve(reportDirectory(cwd, kind), file),
          kind,
        );
        summaries.push(summaryFor(kind, id, report));
      } catch {
        // Invalid JSON is not exposed through the local API.
      }
    }
    try {
      const latest = await readValidated(latestPath(cwd, kind), kind);
      const latestSummary = summaryFor(kind, "latest", latest);
      const durableId =
        kind === "comparison"
          ? comparisonReportSchema.parse(latest).comparison_id
          : smokeReportSchema.parse(latest).run_id;
      if (!durableId || !summaries.some((entry) => entry.id === durableId)) {
        summaries.push(latestSummary);
      }
    } catch {
      // An absent latest alias is a normal empty state.
    }
  }
  return summaries.sort((first, second) => {
    const firstTime = first.created_at ?? "";
    const secondTime = second.created_at ?? "";
    return secondTime.localeCompare(firstTime);
  });
}
