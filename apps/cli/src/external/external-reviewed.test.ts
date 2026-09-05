import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { externalCommand } from "../commands/external.js";
import { doctorCommand, initProjectCommand } from "../commands/project.js";

const sourceApp = resolve(process.cwd(), "examples/refund-agent");
const scenarioDirectory = resolve(process.cwd(), "scenarios/external-refunds");
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

const invalidRefusalClaim = {
  status: "failed",
  paymentId: "",
  refundIds: [],
  amount: 0,
  currency: "",
  message: "NOT_REFUNDABLE",
};

// Only the MODEL endpoint is replaced. The external executable, tool,
// payment HTTP client, retry code, simulator, and evaluators are all real.
async function modelServer(
  options: {
    unavailable?: boolean;
    refuseOnly?: boolean;
    invalidNoBalanceClaim?: boolean;
  } = {},
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
    const toolResult = toolOutput
      ? JSON.parse(toolOutput.output ?? "{}")
      : undefined;
    const refund = toolResult?.refund;
    const output =
      toolOutput || options.refuseOnly
        ? [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(
                    options.invalidNoBalanceClaim &&
                      toolResult?.error === "NOT_REFUNDABLE"
                      ? invalidRefusalClaim
                      : {
                          status:
                            refund?.status === "processed"
                              ? "completed"
                              : "failed",
                          paymentId: task.paymentId,
                          refundIds: refund ? [refund.id] : [],
                          amount: task.amount,
                          currency: task.currency,
                          message: refund
                            ? "One refund was processed."
                            : "The request was refused.",
                        },
                  ),
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
  selectedScenarioDirectory = scenarioDirectory,
) {
  const output: string[] = [];
  const errors: string[] = [];
  const result = await externalCommand(
    {
      cwd,
      appDirectory: app,
      scenarioDirectory: selectedScenarioDirectory,
      runs: "1",
      timeoutMs,
      io: {
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
      },
    },
    {
      environment: { OPENAI_API_KEY: apiKey, OPENAI_MODEL: "offline-model" },
      nextId: () => "external_test",
      modelBaseUrl,
    },
  );
  return { ...result, output, errors };
}

describe("reviewed external refund suite", () => {
  it("runs the explicit doctor execution check through the configured application and saves a blocking suite", async () => {
    const { cwd, app } = await applicationCopy();
    const model = await modelServer();
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (line: string) => output.push(line),
      stderr: (line: string) => errors.push(line),
    };
    const environment = {
      OPENAI_API_KEY: apiKey,
      OPENAI_MODEL: "offline-model",
    };
    expect(
      await initProjectCommand(
        cwd,
        { app, trials: "1", timeoutMs: "10000" },
        io,
        environment,
      ),
    ).toBe(0);
    expect(
      await doctorCommand(cwd, io, true, {
        environment,
        modelBaseUrl: model.baseUrl,
        nextId: () => "doctor_execution",
      }),
    ).toBe(1);
    expect(errors).toEqual([]);
    expect(output.join("\n")).toContain("offline model double");
    const suite = JSON.parse(
      await readFile(
        resolve(cwd, "reports/external/doctor_execution/suite.json"),
        "utf8",
      ),
    );
    expect(suite.runs).toHaveLength(6);
    expect(suite.provenance.reviewed_suite_id).toBe("reviewed-refunds-v1");
    expect(suite.provenance.timeout_ms).toBe(10000);
    expect(suite.decision).toBe("block");
    expect(model.requests).toHaveLength(12);
  });
  it("exercises all six expectations through the real external executable and simulated payment HTTP boundary", async () => {
    const { cwd, app } = await applicationCopy();
    const model = await modelServer();
    const outcome = await execute(cwd, app, model.baseUrl);
    expect(outcome.errors).toEqual([]);
    expect(outcome.exitCode).toBe(1);
    const runs = outcome.report?.runs.map(({ report }) => report) ?? [];
    expect(runs.map((run) => run.result)).toEqual([
      "pass",
      "fail",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(runs.map((run) => run.summary.refund_count)).toEqual([
      1, 2, 1, 0, 1, 0,
    ]);
    expect(runs.map((run) => run.task_expectation)).toEqual([
      "complete",
      "complete",
      "complete",
      "refuse",
      "complete",
      "refuse",
    ]);
    expect(runs.every((run) => run.evaluator_version === "2.0")).toBe(true);
    expect(model.requests).toHaveLength(12);
    for (const index of [3, 5]) {
      const run = runs[index];
      expect(run?.final_claim).toMatchObject({
        status: "failed",
        refundIds: [],
      });
      expect(run?.final_claim_source).toBe("agent");
      expect(run?.findings).toEqual([]);
      expect(
        run?.trace.filter((event) => event.type === "tool.call.requested"),
      ).toHaveLength(0);
      expect(run?.final_world).toEqual(run?.initial_world);
    }
    const partial = runs[4];
    expect(partial?.initial_world.payments[0]?.refunded_amount).toBe(100000);
    expect(partial?.final_world.payments[0]?.refunded_amount).toBe(149900);
    expect(partial?.final_world.refunds[0]?.amount).toBe(49900);
    expect(
      runs[3]?.trace.filter((event) => event.type === "payment.read.returned"),
    ).toHaveLength(0);
    expect(
      runs[5]?.trace.filter((event) => event.type === "payment.read.returned"),
    ).toHaveLength(1);
    const saved = await readFile(
      resolve(cwd, "reports/external-latest.json"),
      "utf8",
    );
    expect(saved).not.toContain(apiKey);
  });

  it("a refusal-only model leaves the actual application failing every legitimate request", async () => {
    const { cwd, app } = await applicationCopy();
    const model = await modelServer({ refuseOnly: true });
    const outcome = await execute(cwd, app, model.baseUrl);
    expect(outcome.exitCode).toBe(1);
    const runs = outcome.report?.runs.map(({ report }) => report) ?? [];
    expect(runs.map((run) => run.result)).toEqual([
      "fail",
      "fail",
      "fail",
      "pass",
      "fail",
      "pass",
    ]);
    expect(runs.every((run) => run.summary.refund_count === 0)).toBe(true);
    for (const index of [0, 1, 2, 4]) {
      expect(runs[index]?.findings.map((finding) => finding.code)).toContain(
        "REQUIRED_FINANCIAL_EFFECT_MISSING",
      );
    }
    expect(model.requests).toHaveLength(6);
  });

  it("unavailable model evidence fails even the refusal scenarios", async () => {
    const { cwd, app } = await applicationCopy();
    const model = await modelServer({ unavailable: true });
    const outcome = await execute(cwd, app, model.baseUrl);
    const runs = outcome.report?.runs.map(({ report }) => report) ?? [];
    expect(runs).toHaveLength(6);
    expect(
      runs.every(
        (run) => run.result === "fail" && run.agent_error !== undefined,
      ),
    ).toBe(true);
    expect(
      runs.every((run) => run.final_claim_source === "eigen_failure_fallback"),
    ).toBe(true);
  });

  it("preserves a malformed original refusal claim and blocks it without financial effects", async () => {
    const { cwd, app } = await applicationCopy();
    const singleScenario = await mkdtemp(resolve(cwd, "no-balance-"));
    await cp(
      resolve(scenarioDirectory, "06-no-balance.yaml"),
      resolve(singleScenario, "06-no-balance.yaml"),
    );
    const model = await modelServer({ invalidNoBalanceClaim: true });
    const outcome = await execute(
      cwd,
      app,
      model.baseUrl,
      "10000",
      singleScenario,
    );
    expect(outcome.errors).toEqual([]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.runs).toHaveLength(1);
    const run = outcome.report?.runs[0]?.report;
    expect(run?.result).toBe("fail");
    expect(run?.agent_error?.code).toBe("EXTERNAL_AGENT_PROTOCOL_ERROR");
    expect(run?.final_claim_source).toBe("eigen_failure_fallback");
    expect(run?.final_claim.status).toBe("unknown");
    expect(run?.final_world).toEqual(run?.initial_world);
    expect(run?.summary.refund_count).toBe(0);
    expect(
      run?.trace.filter((event) => event.type === "tool.call.requested"),
    ).toHaveLength(0);
    expect(
      run?.trace.some(
        (event) =>
          event.type === "model.tool.result" &&
          JSON.stringify(event.payload.result) ===
            JSON.stringify({ ok: false, error: "NOT_REFUNDABLE" }),
      ),
    ).toBe(true);
    expect(
      run?.trace.some(
        (event) =>
          event.type === "agent.message" &&
          event.payload.message === JSON.stringify(invalidRefusalClaim),
      ),
    ).toBe(true);
    expect(
      run?.trace.find((event) => event.type === "agent.final_claim")?.payload,
    ).toMatchObject({
      source: "eigen_failure_fallback",
      claim: { status: "unknown" },
    });
    expect(model.requests).toHaveLength(2);
  });
});
