import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createProject,
  readProject,
  requireProject,
  reviewedSuiteDirectory,
} from "@eigen/external-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorCommand, initProjectCommand } from "./commands/project.js";
import { main } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const env = {
  OPENAI_MODEL: "offline-project-model",
  OPENAI_API_KEY: "offline-project-secret",
};
function io() {
  return { stdout: vi.fn(), stderr: vi.fn() };
}
async function workspace() {
  const cwd = await mkdtemp(resolve(tmpdir(), "eigen-project-"));
  directories.push(cwd);
  const app = await mkdtemp(resolve(tmpdir(), "separate-refund-app-"));
  directories.push(app);
  await mkdir(resolve(app, "dist"));
  const source =
    "throw new Error('Static checks must not execute this application');";
  await writeFile(resolve(app, "source.js"), source);
  await writeFile(resolve(app, "dist/main.js"), source);
  await writeFile(
    resolve(app, "eigen.json"),
    JSON.stringify({
      version: 1,
      id: "separate-app",
      entrypoint: "dist/main.js",
      sourceFiles: ["source.js"],
    }),
  );
  const capture = io();
  expect(
    await initProjectCommand(
      cwd,
      { app, trials: "1", timeoutMs: "15000" },
      capture,
      env,
    ),
  ).toBe(0);
  return { cwd, app, capture };
}
describe("local project setup", () => {
  it("connects an outside application, preserves source, and performs only static doctor checks", async () => {
    const { cwd, app, capture } = await workspace();
    const before = await readFile(resolve(app, "source.js"), "utf8");
    expect(await doctorCommand(cwd, capture, false, { environment: env })).toBe(
      0,
    );
    expect(await readFile(resolve(app, "source.js"), "utf8")).toBe(before);
    const selected = await requireProject(cwd);
    expect(selected.application.directory).toBe(await realpath(app));
    expect(selected.project.model.name).toBe(env.OPENAI_MODEL);
    expect(JSON.stringify(capture)).not.toContain(env.OPENAI_API_KEY);
    expect(capture.stdout.mock.calls.flat().join("\n")).toContain(
      "no model inference",
    );
    const original = await readFile(resolve(cwd, "eigen.project.json"), "utf8");
    expect(
      await initProjectCommand(
        cwd,
        { app, trials: "3", timeoutMs: "15000" },
        capture,
        env,
      ),
    ).toBe(2);
    expect(await readFile(resolve(cwd, "eigen.project.json"), "utf8")).toBe(
      original,
    );
  });
  it("reports missing build and credentials without attempting inference", async () => {
    const { cwd, app, capture } = await workspace();
    await rm(resolve(app, "dist/main.js"));
    expect(await doctorCommand(cwd, capture, true, { environment: {} })).toBe(
      2,
    );
    expect(capture.stderr.mock.calls.flat().join("\n")).toContain(
      "FAIL Application build",
    );
    expect(capture.stderr.mock.calls.flat().join("\n")).toContain(
      "OPENAI_API_KEY is missing",
    );
  });
  it("rejects malformed config, unknown fields, invalid bounds, and secret-bearing input without echoing it", async () => {
    const { cwd, capture } = await workspace();
    const project = await readProject(cwd);
    for (const replacement of [
      { ...project, apiKey: env.OPENAI_API_KEY },
      { ...project, version: 2 },
      { ...project, execution: { trials: 0, timeoutMs: 1 } },
    ]) {
      await writeFile(
        resolve(cwd, "eigen.project.json"),
        JSON.stringify(replacement),
      );
      expect(
        await doctorCommand(cwd, capture, false, { environment: env }),
      ).toBe(2);
    }
    expect(capture.stderr.mock.calls.flat().join("\n")).not.toContain(
      env.OPENAI_API_KEY,
    );
  });
  it("rejects an entrypoint mismatch and edited reviewed scenarios", async () => {
    const { cwd } = await workspace();
    const project = await readProject(cwd);
    if (!project) throw new Error("Missing fixture project");
    await expect(requireProject(cwd)).resolves.toBeDefined();
    await writeFile(
      resolve(cwd, "eigen.project.json"),
      JSON.stringify({
        ...project,
        application: { ...project.application, entrypoint: "dist/other.js" },
      }),
    );
    await expect(requireProject(cwd)).rejects.toThrow("entrypoint");
    const suite = resolve(cwd, "reviewed");
    await cp(reviewedSuiteDirectory, suite, { recursive: true });
    const file = resolve(suite, "01-normal-refund.yaml");
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("seed: 42", "seed: 999"),
    );
    // Independently change the scenario name so the test does not depend on a seed literal.
    await writeFile(
      file,
      (await readFile(file, "utf8")).replace(
        /^name:.*$/m,
        "name: Changed scenario",
      ),
    );
    await writeFile(
      resolve(cwd, "eigen.project.json"),
      JSON.stringify({
        ...project,
        suite: { ...project.suite, directory: suite },
      }),
    );
    await expect(requireProject(cwd)).rejects.toThrow("six shipped reviewed");
  });
  it("registers CLI commands and explains an absent project", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "eigen-unconfigured-"));
    directories.push(cwd);
    const capture = io();
    expect(await main(["node", "eigen", "doctor"], cwd, capture)).toBe(2);
    expect(capture.stderr.mock.calls.flat().join("\n")).toContain("eigen init");
    expect(await main(["node", "eigen", "init", "--help"], cwd, capture)).toBe(
      0,
    );
    expect(
      await main(["node", "eigen", "evaluate", "--help"], cwd, capture),
    ).toBe(0);
    await expect(createProject(cwd, { version: 1 })).rejects.toThrow();
  });
});
