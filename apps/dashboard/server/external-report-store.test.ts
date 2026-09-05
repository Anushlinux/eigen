import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { externalSuiteReportSchema } from "./external-report-schema.js";
import { listDashboardReports, readDashboardReport } from "./report-store.js";

async function fixture() {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/external-suite.json", import.meta.url),
      "utf8",
    ),
  );
}
type TestSuite = Awaited<ReturnType<typeof fixture>>;
async function workspace() {
  const cwd = await mkdtemp(resolve(tmpdir(), "eigen-external-store-"));
  await mkdir(resolve(cwd, "reports/external/suite_test"), { recursive: true });
  return cwd;
}
async function save(
  cwd: string,
  value: unknown,
  path = "reports/external/suite_test/suite.json",
) {
  await writeFile(resolve(cwd, path), JSON.stringify(value));
}

describe("saved external report loading", () => {
  it("loads only embedded runs, preserves raw evidence and gives logical timestamps no wall-clock meaning", async () => {
    const cwd = await workspace();
    const suite = await fixture();
    suite.runs[0].report_path = "../../outside-private-report.json";
    suite.extra_future_metadata = { retained: true };
    suite.runs[0].report.trace.push({
      id: "unknown_event",
      sequence: 999,
      timestamp: "2026-01-01T00:00:01.000Z",
      type: "__proto__",
      payload: { future_detail: ["retained"] },
    });
    await save(cwd, suite);
    await save(cwd, suite, "reports/external-latest.json");
    expect(await readDashboardReport(cwd, "external", "suite_test")).toEqual(
      suite,
    );
    expect(await listDashboardReports(cwd)).toEqual([
      expect.objectContaining({
        kind: "external",
        id: "suite_test",
        created_at: null,
        decision: "block",
        availability: "ready",
        subject: "external-refund-reference",
      }),
    ]);
  });

  it("supports an isolated latest alias and a missing finding event without hiding its report", async () => {
    const cwd = await workspace();
    const suite = await fixture();
    suite.runs[1].report.findings[0].evidence_event_ids.push(
      "missing_event_evidence",
    );
    await save(cwd, suite, "reports/external-latest.json");
    expect(await readDashboardReport(cwd, "external", "latest")).toEqual(suite);
    expect(await listDashboardReports(cwd)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "latest", availability: "ready" }),
        expect.objectContaining({
          id: "suite_test",
          availability: "missing",
          decision: null,
        }),
      ]),
    );
  });

  it.each([
    [
      "duplicate final refund ID",
      (suite: TestSuite) => {
        suite.runs[0].report.final_world.refunds.push(
          structuredClone(suite.runs[0].report.final_world.refunds[0]),
        );
      },
      "malformed",
    ],
    [
      "duplicate initial refund ID",
      (suite: TestSuite) => {
        suite.runs[0].report.initial_world.refunds = Array.from(
          { length: 2 },
          () => structuredClone(suite.runs[0].report.final_world.refunds[0]),
        );
      },
      "malformed",
    ],
    [
      "duplicate payment ID",
      (suite: TestSuite) => {
        suite.runs[0].report.final_world.payments.push(
          structuredClone(suite.runs[0].report.final_world.payments[0]),
        );
      },
      "malformed",
    ],
    [
      "mismatched application identity",
      (suite: TestSuite) => {
        suite.runs[0].report.agent_id = "another-application";
      },
      "malformed",
    ],
    [
      "conflicting scenario name",
      (suite: TestSuite) => {
        const trial = structuredClone(suite.runs[0]);
        trial.report.run_number = 2;
        trial.report.scenario_name = "Conflicting name";
        suite.runs.push(trial);
      },
      "malformed",
    ],
    [
      "missing run completion",
      (suite: TestSuite) => {
        suite.runs[0].report.trace = suite.runs[0].report.trace.filter(
          (event: { type: string }) => event.type !== "run.completed",
        );
      },
      "incomplete",
    ],
    [
      "duplicate run completion",
      (suite: TestSuite) => {
        const trace = suite.runs[0].report.trace;
        trace.push({
          ...structuredClone(trace.at(-1)),
          id: "second_completion",
          sequence: 999,
        });
      },
      "malformed",
    ],
    [
      "contradictory completion verdict",
      (suite: TestSuite) => {
        suite.runs[0].report.trace.at(-1).payload.result = "fail";
      },
      "malformed",
    ],
    [
      "contradictory completion time",
      (suite: TestSuite) => {
        suite.runs[0].report.completed_at = "2026-01-02T00:00:00.000Z";
      },
      "malformed",
    ],
    [
      "negative money",
      (suite: TestSuite) => {
        suite.runs[0].report.mandate.maximum_amount = -1;
      },
      "malformed",
    ],
    [
      "fractional money",
      (suite: TestSuite) => {
        suite.runs[0].report.final_world.refunds[0].amount = 1.5;
      },
      "malformed",
    ],
    [
      "unsafe integer money",
      (suite: TestSuite) => {
        suite.runs[0].report.summary.total_refunded =
          Number.MAX_SAFE_INTEGER + 1;
      },
      "malformed",
    ],
    [
      "malformed known payload",
      (suite: TestSuite) => {
        suite.runs[0].report.trace.find(
          (event: { type: string }) => event.type === "tool.call.requested",
        ).payload.input.amount = "49900";
      },
      "malformed",
    ],
    [
      "missing mandate",
      (suite: TestSuite) => {
        delete suite.runs[0].report.mandate;
      },
      "incomplete",
    ],
    [
      "missing claim",
      (suite: TestSuite) => {
        delete suite.runs[0].report.final_claim;
      },
      "incomplete",
    ],
    [
      "missing claim source",
      (suite: TestSuite) => {
        delete suite.runs[0].report.final_claim_source;
      },
      "incomplete",
    ],
    [
      "missing run number",
      (suite: TestSuite) => {
        delete suite.runs[0].report.run_number;
      },
      "incomplete",
    ],
    [
      "missing refund identity",
      (suite: TestSuite) => {
        delete suite.runs[0].report.final_world.refunds[0].mandate_id;
      },
      "incomplete",
    ],
    [
      "missing findings",
      (suite: TestSuite) => {
        delete suite.runs[0].report.findings;
      },
      "incomplete",
    ],
    [
      "missing embedded run",
      (suite: TestSuite) => {
        delete suite.runs[0].report;
      },
      "incomplete",
    ],
    [
      "empty suite",
      (suite: TestSuite) => {
        suite.runs = [];
      },
      "incomplete",
    ],
    [
      "unsupported suite version",
      (suite: TestSuite) => {
        suite.schema_version = "2.0";
      },
      "unsupported",
    ],
    [
      "unsupported run version",
      (suite: TestSuite) => {
        suite.runs[0].report.schema_version = "2.0";
      },
      "unsupported",
    ],
    [
      "duplicate scenario trial",
      (suite: TestSuite) => {
        suite.runs.push(structuredClone(suite.runs[0]));
      },
      "malformed",
    ],
    [
      "duplicate event ID",
      (suite: TestSuite) => {
        suite.runs[0].report.trace[1].id = suite.runs[0].report.trace[0].id;
      },
      "malformed",
    ],
    [
      "duplicate sequence",
      (suite: TestSuite) => {
        suite.runs[0].report.trace[1].sequence =
          suite.runs[0].report.trace[0].sequence;
      },
      "malformed",
    ],
    [
      "unordered sequence",
      (suite: TestSuite) => {
        suite.runs[0].report.trace.reverse();
      },
      "malformed",
    ],
  ])(
    "rejects %s and leaves an explicit unavailable list entry",
    async (_name, mutate, code) => {
      const cwd = await workspace();
      const suite = await fixture();
      mutate(suite);
      await save(cwd, suite);
      await expect(
        readDashboardReport(cwd, "external", "suite_test"),
      ).rejects.toMatchObject({ code, status: 422 });
      expect(await listDashboardReports(cwd)).toEqual([
        expect.objectContaining({
          kind: "external",
          id: "suite_test",
          availability: code,
          decision: null,
          message: expect.any(String),
        }),
      ]);
    },
  );

  it("reports invalid JSON, a malformed latest alias, and genuinely absent reports separately", async () => {
    const cwd = await workspace();
    await writeFile(
      resolve(cwd, "reports/external/suite_test/suite.json"),
      "{invalid",
    );
    await writeFile(resolve(cwd, "reports/external-latest.json"), "{invalid");
    await expect(
      readDashboardReport(cwd, "external", "suite_test"),
    ).rejects.toMatchObject({ code: "malformed", status: 422 });
    await expect(
      readDashboardReport(cwd, "external", "absent"),
    ).rejects.toMatchObject({ code: "missing", status: 404 });
    expect(await listDashboardReports(cwd)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "latest", availability: "malformed" }),
      ]),
    );
  });

  it("rejects path traversal and symlinks escaping through files, history directories, and latest aliases", async () => {
    const cwd = await workspace();
    const outside = await mkdtemp(resolve(tmpdir(), "eigen-external-outside-"));
    await writeFile(
      resolve(outside, "suite.json"),
      JSON.stringify(await fixture()),
    );
    await symlink(
      resolve(outside, "suite.json"),
      resolve(cwd, "reports/external/suite_test/suite.json"),
    );
    await symlink(outside, resolve(cwd, "reports/external/escaped_directory"));
    await symlink(
      resolve(outside, "suite.json"),
      resolve(cwd, "reports/external-latest.json"),
    );
    await expect(
      readDashboardReport(cwd, "external", "../../outside"),
    ).rejects.toThrow("Invalid report identifier");
    for (const id of ["suite_test", "escaped_directory", "latest"])
      await expect(
        readDashboardReport(cwd, "external", id),
      ).rejects.toMatchObject({ code: "missing", status: 404 });
    expect(
      (await listDashboardReports(cwd)).every(
        (entry) => entry.availability === "missing" && entry.decision === null,
      ),
    ).toBe(true);
  });

  it("confines history directories before enumerating names outside reports", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-confined-list-"));
    const outside = await mkdtemp(resolve(tmpdir(), "eigen-private-history-"));
    await mkdir(resolve(cwd, "reports"));
    await mkdir(resolve(outside, "private_subdir_name"));
    await writeFile(
      resolve(outside, "private_subdir_name/suite.json"),
      JSON.stringify(await fixture()),
    );
    await writeFile(
      resolve(outside, "private_report_name.json"),
      JSON.stringify(await fixture()),
    );
    for (const directory of ["external", "comparisons", "razorpay-smoke"]) {
      await symlink(outside, resolve(cwd, "reports", directory));
    }
    expect(await listDashboardReports(cwd)).toEqual([]);
    await expect(
      readDashboardReport(cwd, "external", "private_subdir_name"),
    ).rejects.toMatchObject({ code: "missing", status: 404 });
    await expect(
      readDashboardReport(cwd, "comparison", "private_report_name"),
    ).rejects.toMatchObject({ code: "missing", status: 404 });
  });

  it("continues to load saved smoke histories alongside external suites", async () => {
    const cwd = await workspace();
    await mkdir(resolve(cwd, "reports/razorpay-smoke"));
    await save(cwd, await fixture());
    const smoke = {
      schema_version: "1.1",
      created_at: "2026-09-01T00:00:00.000Z",
      run_id: "smoke_test",
      agent_id: "openai-refund-v3",
      payment_id: "pay_test",
      result: "pass",
      deployment_decision: "allow",
    };
    await save(cwd, smoke, "reports/razorpay-smoke/smoke_test.json");
    expect(await readDashboardReport(cwd, "smoke", "smoke_test")).toEqual(
      smoke,
    );
    expect(
      (await listDashboardReports(cwd)).map((entry) => entry.kind),
    ).toEqual(["smoke", "external"]);
  });

  it("keeps repeated snapshot IDs and financial TRACE_INCOMPLETE findings inspectable", async () => {
    const cwd = await workspace();
    const suite = await fixture();
    const run = suite.runs[1].report;
    run.initial_world.refunds.push(structuredClone(run.final_world.refunds[0]));
    run.trace = run.trace.filter(
      (event: { type: string }) => event.type !== "payment.refund.created",
    );
    run.findings[0].code = "TRACE_INCOMPLETE";
    run.findings[0].category = "trace_integrity";
    await save(cwd, suite);
    expect(await readDashboardReport(cwd, "external", "suite_test")).toEqual(
      suite,
    );
  });

  it("validates the complete sanitized fixture including an optional agent failure", async () => {
    const suite = await fixture();
    suite.runs[0].report.agent_error = {
      code: "EXTERNAL_PROCESS_FAILED",
      message: "Fixture process failure",
    };
    expect(externalSuiteReportSchema.safeParse(suite).success).toBe(true);
    expect(JSON.stringify(suite)).not.toMatch(
      /\/Users\/|sk-proj-|rzp_(?:test|live)_/,
    );
  });
});
