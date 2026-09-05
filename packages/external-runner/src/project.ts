import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadExternalApplication } from "./application.js";
import { canonicalJson } from "./execute.js";
import { loadScenarios } from "./scenarios.js";

export const PROJECT_FILE = "eigen.project.json";
export const REVIEWED_SUITE_ID = "reviewed-refunds-v1";
export const reviewedSuiteDirectory = fileURLToPath(
  new URL("../../../scenarios/external-refunds", import.meta.url),
);
const path = z.string().trim().min(1).max(4096);
export const projectSchema = z
  .object({
    version: z.literal(1),
    application: z.object({ directory: path, entrypoint: path }).strict(),
    suite: z
      .object({ id: z.literal(REVIEWED_SUITE_ID), directory: path })
      .strict(),
    model: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
    execution: z
      .object({
        trials: z.number().int().min(1).max(3),
        timeoutMs: z.number().int().min(100).max(300_000),
      })
      .strict(),
  })
  .strict();
export type EigenProject = z.infer<typeof projectSchema>;

export async function readProject(
  cwd: string,
): Promise<EigenProject | undefined> {
  let source: string;
  try {
    source = await readFile(resolve(cwd, PROJECT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read eigen.project.json. Check file permissions.");
  }
  try {
    return projectSchema.parse(JSON.parse(source));
  } catch {
    throw new Error(
      "Invalid eigen.project.json. Check version, application paths, model name, reviewed suite, trials (1–3), and timeoutMs (100–300000). Secrets belong in the environment, not this file.",
    );
  }
}

export async function createProject(cwd: string, value: unknown) {
  const project = projectSchema.parse(value);
  await writeFile(
    resolve(cwd, PROJECT_FILE),
    `${JSON.stringify(project, null, 2)}\n`,
    { flag: "wx" },
  );
  return project;
}

export async function validateReviewedSuite(directory: string) {
  const scenarios = await loadScenarios(directory);
  const reviewed = await loadScenarios(reviewedSuiteDirectory);
  const ordered = (items: typeof scenarios) =>
    [...items].sort((a, b) => a.id.localeCompare(b.id));
  if (
    scenarios.length !== 6 ||
    canonicalJson(ordered(scenarios)) !== canonicalJson(ordered(reviewed))
  )
    throw new Error(
      "The configured suite must match all six shipped reviewed refund scenarios. Restore the reviewed suite before evaluating.",
    );
  return scenarios;
}

export async function resolveProject(cwd: string, project: EigenProject) {
  const application = await loadExternalApplication(
    resolve(cwd, project.application.directory),
  );
  if (application.entrypoint !== project.application.entrypoint)
    throw new Error(
      "Configured entrypoint does not match the application's eigen.json. Update the project configuration or application manifest, then rebuild.",
    );
  const scenarioDirectory = resolve(cwd, project.suite.directory);
  const scenarios = await validateReviewedSuite(scenarioDirectory);
  return { project, application, scenarios, scenarioDirectory };
}

export async function requireProject(cwd: string) {
  const project = await readProject(cwd);
  if (!project)
    throw new Error(
      "No eigen.project.json. Run eigen init --app <application-directory> first.",
    );
  return resolveProject(cwd, project);
}
