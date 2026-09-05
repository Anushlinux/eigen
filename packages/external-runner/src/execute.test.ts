import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponsesModel } from "../../../examples/refund-agent/src/model.js";
import { canonicalJson, executeExternalSuite } from "./execute.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const environment = {
  OPENAI_API_KEY: "offline-only",
  OPENAI_MODEL: "offline-model",
};
async function fixture(
  settingsMode: "complete" | "missing" | "conflicting" | "hang" = "complete",
) {
  const cwd = await mkdtemp(resolve(tmpdir(), "eigen-runner-"));
  directories.push(cwd);
  const app = resolve(cwd, "app");
  await mkdir(resolve(app, "dist"), { recursive: true });
  await mkdir(resolve(cwd, "scenarios"));
  await cp(
    resolve(process.cwd(), "scenarios/refunds/01-normal-refund.yaml"),
    resolve(cwd, "scenarios/normal.yaml"),
  );
  await writeFile(
    resolve(app, "eigen.json"),
    JSON.stringify({
      version: 1,
      id: "offline-app",
      entrypoint: "dist/index.js",
      sourceFiles: ["source.txt"],
    }),
  );
  await writeFile(
    resolve(app, "source.txt"),
    "Explicit offline executable test double.",
  );
  const script = `
const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let source = "";
process.stdin.on("data", (chunk) => source += chunk);
process.stdin.on("end", () => {
  const task = JSON.parse(source);
  const mode = ${JSON.stringify(settingsMode)};
  send({type:"configuration", model:process.env.OPENAI_MODEL, prompt_hash:"a".repeat(64),tool_manifest_hash:"b".repeat(64),execution_policy:{max_turns:4,model_timeout_ms:60000}});
  if (mode === "hang") { setInterval(() => {}, 1000); return; }
  for (let turn = 1; turn <= 2; turn++) {
    const settings = {settings_version:1,model:process.env.OPENAI_MODEL,store:true,max_output_tokens:mode === "conflicting" ? 1000 * turn : 2500,parallel_tool_calls:false,additional_parameters:{}};
    send({type:"model_started",turn,...(mode === "missing" ? {} : {settings})});
    send({type:"model_finished",turn,outcome:"success",latency_ms:0});
  }
  send({type:"final",claim:{status:"failed",paymentId:task.paymentId,refundIds:[],amount:task.amount,currency:task.currency,message:"Offline refusal"}});
});`;
  await writeFile(resolve(app, "dist/index.js"), script);
  return {
    cwd,
    appDirectory: "app",
    scenarioDirectory: "scenarios",
    runs: 1,
    timeoutMs: 1000,
  };
}

describe("shared external execution", () => {
  it("rejects scenarios changed after validation before reserving a report", async () => {
    const options = await fixture();
    await expect(
      executeExternalSuite(
        { ...options, expectedScenarioHash: "0".repeat(64) },
        { environment },
      ),
    ).rejects.toThrow("Reviewed scenarios changed after setup validation");
  });
  it("rejects an application changed after validation before starting any trial", async () => {
    const options = await fixture();
    await expect(
      executeExternalSuite(
        { ...options, expectedApplicationHash: "0".repeat(64) },
        { environment },
      ),
    ).rejects.toThrow("Application changed after setup validation");
  });
  it("records complete provenance and preserves saved evidence when a suite ID collides", async () => {
    const options = await fixture();
    const dependencies = {
      environment,
      nextId: () => "immutable_suite",
      now: () => "2026-09-05T00:00:00.000Z",
      modelBaseUrl: "http://127.0.0.1:1",
    };
    const progress: unknown[] = [];
    const suite = await executeExternalSuite(
      {
        ...options,
        reviewedSuiteId: "reviewed-refunds-v1",
        onProgress: (value) => {
          progress.push(value);
        },
      },
      dependencies,
    );
    expect(suite.decision).toBe("block");
    expect(suite.runs[0]?.report.agent_error).toBeUndefined();
    expect(suite.provenance.model_configuration).toMatchObject({
      verified: true,
      settings: { additional_parameters: {} },
      execution_policy: { max_turns: 4 },
    });
    expect(suite.provenance.scenarios[0]?.scenario).not.toHaveProperty("agent");
    expect(suite.provenance.scenarios[0]?.content_hash).toBe(
      createHash("sha256")
        .update(canonicalJson(suite.provenance.scenarios[0]?.scenario))
        .digest("hex"),
    );
    expect(progress).toMatchObject([
      { completed: 0, total: 1 },
      { completed: 1, total: 1 },
    ]);
    const path = resolve(
      options.cwd,
      "reports/external/immutable_suite/suite.json",
    );
    const original = await readFile(path, "utf8");
    await expect(
      executeExternalSuite(options, dependencies),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe(original);
    expect(
      await readFile(
        resolve(options.cwd, "reports/external-latest.json"),
        "utf8",
      ),
    ).toBe(original);
  });

  it.each(["missing", "conflicting"] as const)(
    "keeps %s model settings inspectable but unverified",
    async (mode) => {
      const options = await fixture(mode);
      const suite = await executeExternalSuite(options, {
        environment,
        modelBaseUrl: "http://127.0.0.1:1",
      });
      expect(suite.provenance.model_configuration.verified).toBe(false);
      expect(suite.runs[0]?.report.agent_error).toBeUndefined();
      expect(suite.decision).toBe("block");
    },
  );

  it("terminates an interrupted child and preserves partial evidence without publishing completion", async () => {
    const options = await fixture("hang");
    const abort = new AbortController();
    const execution = executeExternalSuite(
      {
        ...options,
        signal: abort.signal,
        onProgress: () => {
          setTimeout(() => abort.abort(), 150);
        },
      },
      {
        environment,
        nextId: () => "interrupted",
        modelBaseUrl: "http://127.0.0.1:1",
      },
    );
    await expect(execution).rejects.toThrow();
    await expect(
      readFile(resolve(options.cwd, "reports/external/interrupted/suite.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(resolve(options.cwd, "reports/external-latest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const partial = JSON.parse(
      await readFile(
        resolve(options.cwd, "reports/external/interrupted/run-1.json"),
        "utf8",
      ),
    );
    expect(partial.agent_error).toBeDefined();
  });

  it("derives telemetry from the same request sent to the model, including extra provider settings", async () => {
    const events: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "completed", output: [] }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const model = new ResponsesModel(
      "offline-model",
      "offline-only",
      (event) => events.push(event),
      () => 0,
    );
    await model.respond({
      parallel_tool_calls: false,
      reasoning: { effort: "high" },
      text: { format: { type: "json_schema" }, verbosity: "low" },
      instructions: "private application instructions",
      input: [],
    });
    const request = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      model: "offline-model",
      store: true,
      max_output_tokens: 2500,
      reasoning: { effort: "high" },
    });
    expect(events[0]).toMatchObject({
      type: "model_started",
      settings: {
        model: request.model,
        store: request.store,
        max_output_tokens: request.max_output_tokens,
        parallel_tool_calls: request.parallel_tool_calls,
        additional_parameters: {
          reasoning: { effort: "high" },
          text: { verbosity: "low" },
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain(
      "private application instructions",
    );
    expect(JSON.stringify(events)).not.toContain("offline-only");
  });
});
