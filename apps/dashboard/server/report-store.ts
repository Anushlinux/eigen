import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { externalSuiteReportSchema } from "./external-report-schema.js";

export type DashboardReportKind = "comparison" | "smoke" | "external";

export interface DashboardReportSummary {
  kind: DashboardReportKind;
  id: string;
  created_at: string | null;
  decision: "allow" | "block" | null;
  availability?:
    | "ready"
    | "missing"
    | "malformed"
    | "incomplete"
    | "unsupported";
  message?: string;
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

export type ReportErrorCode =
  | "missing"
  | "malformed"
  | "incomplete"
  | "unsupported";

export class DashboardReportError extends Error {
  readonly status: number;
  constructor(
    readonly code: ReportErrorCode,
    message: string,
  ) {
    super(message);
    this.status = code === "missing" ? 404 : 422;
  }
}

function parseExternalReport(value: unknown): unknown {
  const envelope = z
    .object({
      schema_version: z.unknown().optional(),
      runs: z.unknown().optional(),
    })
    .passthrough()
    .safeParse(value);
  if (envelope.success) {
    const version = envelope.data.schema_version;
    if (version !== undefined && version !== "1.0")
      throw new DashboardReportError(
        "unsupported",
        "This external suite schema version is not supported.",
      );
    if (Array.isArray(envelope.data.runs)) {
      for (const entry of envelope.data.runs) {
        const nested = z
          .object({
            report: z
              .object({ schema_version: z.unknown().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .safeParse(entry);
        const runVersion = nested.success
          ? nested.data.report?.schema_version
          : undefined;
        if (runVersion !== undefined && runVersion !== "1.1")
          throw new DashboardReportError(
            "unsupported",
            "This embedded run schema version is not supported.",
          );
      }
    }
  }
  const parsed = externalSuiteReportSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const incomplete = parsed.error.issues.some((issue) => {
    let field: unknown = value;
    for (const key of issue.path) {
      field =
        field !== null && typeof field === "object"
          ? (field as Record<PropertyKey, unknown>)[key]
          : undefined;
    }
    return (
      (issue.code === "custom" &&
        issue.params?.availability === "incomplete") ||
      field === undefined ||
      (issue.code === "too_small" && Array.isArray(field))
    );
  });
  throw new DashboardReportError(
    incomplete ? "incomplete" : "malformed",
    incomplete
      ? "The external suite is incomplete: required embedded report data is missing."
      : "The external suite contains malformed report data.",
  );
}

function parseReport(kind: DashboardReportKind, value: unknown): unknown {
  if (kind === "external") return parseExternalReport(value);
  return kind === "comparison"
    ? comparisonReportSchema.parse(value)
    : smokeReportSchema.parse(value);
}

function reportDirectory(cwd: string, kind: DashboardReportKind): string {
  return resolve(
    cwd,
    "reports",
    kind === "comparison"
      ? "comparisons"
      : kind === "external"
        ? "external"
        : "razorpay-smoke",
  );
}

function latestPath(cwd: string, kind: DashboardReportKind): string {
  return resolve(
    cwd,
    "reports",
    kind === "comparison"
      ? "comparison-latest.json"
      : kind === "external"
        ? "external-latest.json"
        : "razorpay-smoke-latest.json",
  );
}

async function confinedReportPath(cwd: string, path: string): Promise<string> {
  const root = await realpath(resolve(cwd, "reports"));
  const target = await realpath(path);
  const withinRoot = relative(root, target);
  if (
    withinRoot === ".." ||
    withinRoot.startsWith("../") ||
    isAbsolute(withinRoot)
  ) {
    throw new DashboardReportError(
      "missing",
      "Report not found inside the reports directory.",
    );
  }
  return target;
}

async function readValidated(
  cwd: string,
  path: string,
  kind: DashboardReportKind,
): Promise<unknown> {
  let source: string;
  try {
    // Resolve confinement before reading content. The same boundary protects
    // directory enumeration below; report_path is never followed.
    source = await readFile(await confinedReportPath(cwd, path), "utf8");
  } catch (error) {
    if (error instanceof DashboardReportError) throw error;
    throw new DashboardReportError("missing", "Report not found.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new DashboardReportError(
      "malformed",
      "The report is not valid JSON.",
    );
  }
  return parseReport(kind, value);
}

function summaryFor(
  kind: DashboardReportKind,
  id: string,
  value: unknown,
): DashboardReportSummary {
  if (kind === "external") {
    const report = externalSuiteReportSchema.parse(value);
    return {
      kind,
      id,
      created_at:
        typeof report.created_at === "string" ? report.created_at : null,
      decision: report.decision,
      subject: report.application.id,
      schema_version: report.schema_version,
      availability: "ready",
    };
  }
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
      : kind === "external"
        ? resolve(reportDirectory(cwd, kind), id, "suite.json")
        : resolve(reportDirectory(cwd, kind), `${id}.json`);
  if (
    kind !== "external" &&
    id !== "latest" &&
    basename(path) !== `${id}.json`
  ) {
    throw new Error("Invalid report identifier.");
  }
  return readValidated(cwd, path, kind);
}

export async function listDashboardReports(
  cwd: string,
): Promise<DashboardReportSummary[]> {
  const summaries: DashboardReportSummary[] = [];
  for (const kind of ["comparison", "smoke"] as const) {
    let files: string[] = [];
    try {
      files = (
        await readdir(await confinedReportPath(cwd, reportDirectory(cwd, kind)))
      )
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
          cwd,
          resolve(reportDirectory(cwd, kind), file),
          kind,
        );
        summaries.push(summaryFor(kind, id, report));
      } catch {
        // Invalid JSON is not exposed through the local API.
      }
    }
    try {
      const latest = await readValidated(cwd, latestPath(cwd, kind), kind);
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
  let externalDirectories: string[] = [];
  try {
    externalDirectories = (
      await readdir(
        await confinedReportPath(cwd, reportDirectory(cwd, "external")),
        { withFileTypes: true },
      )
    )
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((id) => identifierPattern.test(id))
      .sort();
  } catch {
    /* An absent external history is a normal empty state. */
  }
  const externalIds = new Set<string>();
  for (const id of externalDirectories) {
    try {
      const report = await readDashboardReport(cwd, "external", id);
      summaries.push(summaryFor("external", id, report));
      externalIds.add(externalSuiteReportSchema.parse(report).suite_id);
    } catch (error) {
      const failure =
        error instanceof DashboardReportError
          ? error
          : new DashboardReportError(
              "malformed",
              "The external suite contains malformed report data.",
            );
      summaries.push({
        kind: "external",
        id,
        created_at: null,
        decision: null,
        subject: id,
        schema_version: "unknown",
        availability: failure.code,
        message: failure.message,
      });
    }
  }
  try {
    const latest = await readDashboardReport(cwd, "external", "latest");
    if (!externalIds.has(externalSuiteReportSchema.parse(latest).suite_id))
      summaries.push(summaryFor("external", "latest", latest));
  } catch (error) {
    if (error instanceof DashboardReportError && error.code !== "missing") {
      summaries.push({
        kind: "external",
        id: "latest",
        created_at: null,
        decision: null,
        subject: "Latest external suite",
        schema_version: "unknown",
        availability: error.code,
        message: error.message,
      });
    }
  }
  return summaries.sort((first, second) => {
    const firstTime = first.created_at ?? "";
    const secondTime = second.created_at ?? "";
    return secondTime.localeCompare(firstTime);
  });
}
