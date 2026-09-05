import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { applicationFromFiles, buildRepository } from "./evaluation.js";
import { type RepositorySandbox, relaySource } from "./sandbox.js";

describe("isolated application transport", () => {
  it("relays a real subprocess's payment and inference requests with run-only credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "eigen-relay-"));
    const requests: Record<string, unknown>[] = [];
    const output: string[] = [];
    try {
      await writeFile(
        join(directory, "relay.cjs"),
        relaySource.replaceAll("/home/user/repo", directory),
      );
      await writeFile(
        join(directory, "agent.cjs"),
        `
        (async()=>{
          const model=await fetch(process.env.OPENAI_BASE_URL+'/responses',{method:'POST',body:JSON.stringify({model:process.env.OPENAI_MODEL,input:[]})});
          const payment=await fetch(process.env.EIGEN_PAYMENT_BASE_URL+'/v1/payments/pay_test/refund',{method:'POST',headers:{'x-eigen-token':process.env.EIGEN_PAYMENT_TOKEN,'x-request-id':'application-request'},body:JSON.stringify({amount:29,currency:'INR',case_id:'case'})});
          console.log(JSON.stringify({model:await model.json(),payment:await payment.json(),key:process.env.OPENAI_API_KEY,hasGithub:Boolean(process.env.GITHUB_APP_PRIVATE_KEY),hasDatabase:Boolean(process.env.DATABASE_URL)}));
        })().catch(()=>process.exit(1));
      `,
      );
      const child = spawn(process.execPath, [join(directory, "relay.cjs")], {
        env: {
          ...process.env,
          OPENAI_API_KEY: "secret-master-must-not-reach-child",
          GITHUB_APP_PRIVATE_KEY: "private-key",
          DATABASE_URL: "private-database",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let diagnostic = "";
      child.stderr.on("data", (chunk) => {
        diagnostic += chunk.toString();
      });
      const timer = setTimeout(() => child.kill(), 5000);
      createInterface({ input: child.stdout }).on("line", (line) => {
        const event = JSON.parse(line);
        if (event.kind === "rpc") {
          requests.push(event);
          child.stdin.write(
            `${JSON.stringify({ kind: "reply", id: event.id, status: 200, body: JSON.stringify({ id: event.target }) })}\n`,
          );
        } else if (event.kind === "stdout") output.push(event.data);
      });
      child.stdin.write(
        `${JSON.stringify({ kind: "start", entrypoint: "agent.cjs", model: "configured-model", input: "{}\n" })}\n`,
      );
      const code = await new Promise((resolve) => child.once("close", resolve));
      clearTimeout(timer);
      expect(code, diagnostic).toBe(0);
      expect(requests.map((request) => request.target)).toEqual([
        "model",
        "payment",
      ]);
      expect(JSON.parse(String(requests[1]?.body)).amount).toBe(29);
      expect(JSON.stringify(requests)).not.toContain("secret-master");
      const result = JSON.parse(output.join(""));
      expect(result).toMatchObject({
        key: "eigen-run-scoped",
        hasGithub: false,
        hasDatabase: false,
        model: { id: "model" },
        payment: { id: "payment" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects arbitrary server paths and missing source files in generated manifests", () => {
    for (const entrypoint of ["/private/agent.js", "../agent.js", "missing.js"])
      expect(() =>
        applicationFromFiles({
          "eigen.json": JSON.stringify({
            version: 1,
            id: "app",
            entrypoint,
            sourceFiles: ["agent.js"],
          }),
          "agent.js": "source",
        }),
      ).toThrow();
  });
  it("requires locked installs and takes the sandbox offline before repository code runs", async () => {
    const commands: string[] = [];
    const sandbox = {
      command: async (command: string) => {
        commands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      offline: async () => {
        commands.push("offline");
      },
    } as RepositorySandbox;
    await expect(
      buildRepository(sandbox, { "package.json": "{}" }, async () => {}),
    ).rejects.toThrow("lockfile");
    await buildRepository(
      sandbox,
      {
        "package-lock.json": "{}",
        "package.json": JSON.stringify({
          scripts: { build: "tsc", test: "node test.js" },
        }),
      },
      async () => {},
    );
    expect(commands).toEqual([
      "npm ci --ignore-scripts --no-audit --no-fund",
      "offline",
      "npm run build",
      "npm test",
    ]);
  });
});
