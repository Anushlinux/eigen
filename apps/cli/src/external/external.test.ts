import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { runScenario } from "@eigen/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadScenarios } from "../commands/compare.js";
import { externalCommand } from "../commands/external.js";
import { main } from "../index.js";
import { loadExternalApplication } from "./application.js";
import { startPaymentServer } from "./payment-server.js";

const sourceApp = resolve(process.cwd(), "examples/refund-agent");
const scenarioDirectory = resolve(process.cwd(), "scenarios/refunds");
const temporaryDirectories: string[] = [];
const closers: Array<() => Promise<void>> = [];
const apiKey = "offline-test-secret-not-a-real-key";

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function applicationCopy() {
  const cwd = await mkdtemp(resolve(tmpdir(), "eigen-external-"));
  temporaryDirectories.push(cwd);
  const app = resolve(cwd, "independent-application");
  await cp(sourceApp, app, {
    recursive: true,
    filter: (path) =>
      !["node_modules", ".git", ".env", ".env.local"].includes(basename(path)),
  });
  return { cwd, app };
}

// Only the MODEL endpoint is replaced. The external executable, tool,
// payment HTTP client, retry code, simulator, and evaluators are all real.
async function modelServer(
  options: { unavailable?: boolean; leak?: boolean } = {},
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      input: Array<{
        role?: string;
        content?: string;
        type?: string;
        output?: string;
      }>;
    };
    requests.push(body);
    if (options.unavailable) {
      response.writeHead(503);
      response.end("unavailable");
      return;
    }
    const task = JSON.parse(body.input[0]?.content ?? "{}");
    const toolOutput = body.input.find(
      (item) => item.type === "function_call_output",
    );
    const refund = toolOutput
      ? JSON.parse(toolOutput.output ?? "{}").refund
      : undefined;
    const output = toolOutput
      ? [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  status:
                    refund?.status === "processed" ? "completed" : "failed",
                  paymentId: task.paymentId,
                  refundIds: refund ? [refund.id] : [],
                  amount: task.amount,
                  currency: task.currency,
                  message: options.leak ? apiKey : "One refund was processed.",
                }),
              },
            ],
          },
        ]
      : [
          {
            type: "function_call",
            name: "refund_payment",
            call_id: "call_refund",
            arguments: JSON.stringify({
              paymentId: task.paymentId,
              amount: task.amount,
              currency: task.currency,
            }),
          },
        ];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        status: "completed",
        output,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          input_tokens_details: { cached_tokens: 0 },
        },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No model endpoint");
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function execute(
  cwd: string,
  app: string,
  modelBaseUrl: string,
  timeoutMs = "10000",
  suiteId = "external_test",
) {
  const output: string[] = [];
  const errors: string[] = [];
  const result = await externalCommand(
    {
      cwd,
      appDirectory: app,
      scenarioDirectory,
      runs: "1",
      timeoutMs,
      io: {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      },
    },
    {
      environment: { OPENAI_API_KEY: apiKey, OPENAI_MODEL: "offline-model" },
      nextId: () => suiteId,
      modelBaseUrl,
    },
  );
  return { ...result, output, errors };
}

describe("external application execution", () => {
  it("runs the standalone application in a fresh process and catches its real retry defect", async () => {
    const { cwd, app } = await applicationCopy();
    const model = await modelServer();
    const outcome = await execute(cwd, app, model.baseUrl);
    expect(outcome.errors).toEqual([]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.model_execution).toBe("test_double");
    const runs = outcome.report?.runs.map((run) => run.report) ?? [];
    expect(runs.map((run) => run.result)).toEqual(["pass", "fail", "pass"]);
    expect(runs.map((run) => run.summary.refund_count)).toEqual([1, 2, 1]);
    expect(model.requests).toHaveLength(6);
    expect(model.requests.every((request) => request.store === true)).toBe(
      true,
    );
    const duplicate = runs[1];
    expect(duplicate?.agent_id).toBe("external-refund-reference");
    expect(duplicate?.agent_error).toBeUndefined();
    expect(duplicate?.summary.total_refunded).toBe(99_800);
    const finding = duplicate?.findings.find(
      (finding) => finding.code === "DUPLICATE_FINANCIAL_EFFECT",
    );
    expect(finding?.evidence_event_ids).toHaveLength(2);
    const events = duplicate?.trace ?? [];
    const created = events.filter(
      (event) => event.type === "payment.refund.created",
    );
    const fault = events.find((event) => event.type === "fault.injected");
    const retry = events.find((event) => event.type === "agent.retry");
    expect(created[0]?.sequence).toBeLessThan(fault?.sequence ?? 0);
    expect(fault?.sequence).toBeLessThan(retry?.sequence ?? 0);
    expect(retry?.sequence).toBeLessThan(created[1]?.sequence ?? 0);
    expect(
      events.some((event) => event.type === "agent.reconciliation.started"),
    ).toBe(false);
    expect(
      events.filter((event) => event.type === "model.tool.selected"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "tool.call.requested"),
    ).toHaveLength(2);
    expect(events.some((event) => event.type === "payment.read.returned")).toBe(
      true,
    );
    const visible = JSON.stringify(
      events.filter((event) =>
        ["model.tool.result", "agent.message"].includes(event.type),
      ),
    );
    expect(visible).not.toContain(created[0]?.payload.refund.id);
    expect(visible).not.toContain("timeout_after_side_effect");
    for (const run of runs) {
      expect(run.final_world.refunds[0]?.request_id).toBe(
        run.scenario_id.includes("before") ? "request_2" : "request_1",
      );
    }
    const saved = await readFile(
      resolve(cwd, "reports/external-latest.json"),
      "utf8",
    );
    expect(saved).not.toContain(apiKey);
    expect(JSON.parse(saved).application.files["dist/agent.js"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("changes the outcome when the EXTERNAL application's key handling changes", async () => {
    const { cwd, app } = await applicationCopy();
    const before = await loadExternalApplication(app);
    const codePath = resolve(app, "dist/agent.js");
    const original = await readFile(codePath, "utf8");
    expect(original).toMatch(/idempotencyKey:.*requestId/);
    await writeFile(
      codePath,
      original.replace(
        /idempotencyKey: [^\n]+/,
        "idempotencyKey: request.caseId,",
      ),
    );
    const after = await loadExternalApplication(app);
    expect(after.contentHash).not.toBe(before.contentHash);
    const model = await modelServer();
    const outcome = await execute(cwd, app, model.baseUrl);
    expect(outcome.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    expect(
      outcome.report?.runs.map(({ report }) => report.summary.refund_count),
    ).toEqual([1, 1, 1]);
    expect(
      outcome.report?.runs[1]?.report.trace.some(
        (event) => event.type === "payment.refund.deduplicated",
      ),
    ).toBe(true);
  });

  it("keeps model outages distinct from an observed duplicate and never passes them", async () => {
    const { cwd, app } = await applicationCopy();
    const model = await modelServer({ unavailable: true });
    const outcome = await execute(cwd, app, model.baseUrl);
    expect(outcome.exitCode).toBe(1);
    for (const { report } of outcome.report?.runs ?? []) {
      expect(report.agent_error).toBeDefined();
      expect(report.final_claim_source).toBe("eigen_failure_fallback");
      expect(report.summary.refund_count).toBe(0);
      expect(
        report.findings.some(
          (finding) => finding.code === "DUPLICATE_FINANCIAL_EFFECT",
        ),
      ).toBe(false);
      expect(
        report.trace.some(
          (event) =>
            event.type === "model.request.finished" &&
            event.payload.outcome === "error",
        ),
      ).toBe(true);
    }
  });

  it("bounds a hanging external process, closes it, and preserves a failure report", async () => {
    const { cwd, app } = await applicationCopy();
    await writeFile(
      resolve(app, "dist/main.js"),
      "setInterval(() => {}, 1000);\n",
    );
    const model = await modelServer();
    const outcome = await execute(cwd, app, model.baseUrl, "150");
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.runs).toHaveLength(3);
    expect(
      outcome.report?.runs.every(
        ({ report }) => report.agent_error?.code === "EXTERNAL_AGENT_TIMEOUT",
      ),
    ).toBe(true);
    expect(model.requests).toHaveLength(0);
  });

  it("rejects malformed output and redacts known secrets from valid telemetry", async () => {
    const { cwd, app } = await applicationCopy();
    const model = await modelServer({ leak: true });
    const outcome = await execute(cwd, app, model.baseUrl);
    expect(JSON.stringify(outcome)).not.toContain(apiKey);
    expect(JSON.stringify(outcome.report)).toContain("[REDACTED]");
    await writeFile(resolve(app, "dist/main.js"), "console.log('not-json');\n");
    const malformed = await execute(
      cwd,
      app,
      model.baseUrl,
      "10000",
      "external_malformed",
    );
    expect(
      malformed.report?.runs.every(
        ({ report }) =>
          report.agent_error?.code === "EXTERNAL_AGENT_PROTOCOL_ERROR",
      ),
    ).toBe(true);
  });

  it("rejects path traversal in the external application manifest", async () => {
    const { app } = await applicationCopy();
    const path = resolve(app, "eigen.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.entrypoint = "../other.js";
    await writeFile(path, JSON.stringify(manifest));
    await expect(loadExternalApplication(app)).rejects.toThrow();
  });

  it("does not turn reused request IDs into idempotency when no key was supplied", async () => {
    const scenario = (await loadScenarios(scenarioDirectory))[0];
    if (!scenario) throw new Error("Missing scenario");
    const result = await runScenario({
      scenario,
      agent: {
        id: "unkeyed-http-client",
        async run(input) {
          const server = await startPaymentServer(input, "session-token");
          try {
            const path = `${server.baseUrl}/v1/payments/${input.task.payment_id}/refund`;
            expect((await fetch(path, { method: "POST" })).status).toBe(403);
            const refunds: Array<{ id: string }> = [];
            for (let attempt = 0; attempt < 2; attempt++) {
              const response = await fetch(path, {
                method: "POST",
                headers: {
                  "X-Eigen-Token": "session-token",
                  "X-Request-Id": "same-transport-request",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  amount: input.task.amount,
                  currency: input.task.currency,
                  case_id: input.task.purpose,
                }),
              });
              expect(response.status).toBe(200);
              refunds.push((await response.json()) as { id: string });
            }
            return {
              status: "completed",
              paymentId: input.task.payment_id,
              amount: input.task.amount,
              currency: input.task.currency,
              refundIds: refunds.map((refund) => refund.id),
              message: "Refund calls returned.",
            };
          } finally {
            await server.close();
          }
        },
      },
    });
    expect(result.final_world.refunds).toHaveLength(2);
    expect(
      result.findings.some(
        (finding) => finding.code === "DUPLICATE_FINANCIAL_EFFECT",
      ),
    ).toBe(true);
  });

  it("registers the command and rejects invalid trial budgets before execution", async () => {
    const lines: string[] = [];
    const io = {
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(line),
    };
    expect(
      await main(["node", "eigen", "external", "--help"], process.cwd(), io),
    ).toBe(0);
    expect(lines.join("\n")).toContain("--app");
    expect(
      await main(
        [
          "node",
          "eigen",
          "external",
          scenarioDirectory,
          "--app",
          sourceApp,
          "--runs",
          "0",
        ],
        process.cwd(),
        io,
      ),
    ).toBe(2);
    expect(lines.join("\n")).toContain("--runs must be an integer");
  });
});
