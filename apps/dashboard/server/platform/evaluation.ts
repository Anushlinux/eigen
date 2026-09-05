import { createHash } from "node:crypto";
import {
  createRunReport,
  FINANCIAL_EVALUATOR_VERSION,
  runScenario,
  type Scenario,
  SystemMonotonicTimer,
} from "@eigen/core";
import {
  canonicalJson,
  type ExternalApplication,
  ExternalProcessAgent,
  type ExternalSuiteReport,
  scenarioProvenance,
  verifiedConfiguration,
} from "@eigen/external-runner";
import { z } from "zod";
import type { RepositorySandbox, SandboxProvider } from "./sandbox.js";
import { safeRepoPath } from "./security.js";
import { PlatformError } from "./types.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function applicationFromFiles(
  files: Record<string, string>,
): ExternalApplication {
  const manifest = z
    .object({
      version: z.literal(1),
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      entrypoint: z.string().endsWith(".js"),
      sourceFiles: z.array(z.string()).min(1).max(100),
    })
    .strict()
    .parse(JSON.parse(files["eigen.json"] ?? "{}"));
  for (const path of [...manifest.sourceFiles, manifest.entrypoint])
    if (files[safeRepoPath(path)] === undefined)
      throw new PlatformError(
        422,
        "Integration manifest references a missing file. Build the application before evaluating.",
      );
  const hashes = Object.fromEntries(
    Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, content]) => [path, hash(content)]),
  );
  return {
    directory: "/home/user/repo",
    id: manifest.id,
    entrypoint: manifest.entrypoint,
    files: hashes,
    contentHash: hash(canonicalJson(hashes)),
  };
}
export async function buildRepository(
  sandbox: RepositorySandbox,
  files: Record<string, string>,
  event: (stage: string, message: string) => Promise<void>,
) {
  const pkg = JSON.parse(files["package.json"] ?? "{}") as {
    scripts?: Record<string, string>;
    packageManager?: string;
  };
  const manager = files["pnpm-lock.yaml"]
    ? "pnpm"
    : files["package-lock.json"]
      ? "npm"
      : null;
  if (!manager)
    throw new PlatformError(
      422,
      "A committed npm or pnpm lockfile is required for reproducible builds.",
    );
  const prefix = manager === "pnpm" ? "corepack pnpm" : "npm";
  await event(
    "building",
    "Installing locked public dependencies inside the isolated sandbox.",
  );
  const install = await sandbox.command(
    `${prefix} ${manager === "pnpm" ? "install --frozen-lockfile --ignore-scripts" : "ci --ignore-scripts --no-audit --no-fund"}`,
    45000,
  );
  if (install.exitCode !== 0)
    throw new PlatformError(
      422,
      `Dependency installation failed. ${install.stderr.slice(-1500)}`,
    );
  await sandbox.offline();
  if (pkg.scripts?.build) {
    const build = await sandbox.command(`${prefix} run build`);
    await event(
      "building",
      `Build exited ${build.exitCode}. ${build.stdout.slice(-1500)} ${build.stderr.slice(-1500)}`,
    );
    if (build.exitCode !== 0)
      throw new PlatformError(
        422,
        "The repository build failed. Inspect the build activity and update its configuration.",
      );
  }
  if (pkg.scripts?.test) {
    const test = await sandbox.command(`${prefix} test`);
    await event(
      "checking",
      `Repository tests exited ${test.exitCode}. ${test.stdout.slice(-1500)} ${test.stderr.slice(-1500)}`,
    );
    if (test.exitCode !== 0)
      throw new PlatformError(
        422,
        "The repository's own tests failed. The integration is not verified.",
      );
  }
}

export interface EvaluationProvider {
  evaluate(input: {
    files: Record<string, string>;
    scenarios: Scenario[];
    model: string;
    id: string;
    signal: AbortSignal;
    event(stage: string, message: string): Promise<void>;
  }): Promise<ExternalSuiteReport>;
}
export function createSandboxEvaluator(
  sandboxes: SandboxProvider,
  apiKey: string,
  now = () => new Date(),
): EvaluationProvider {
  return {
    async evaluate(input) {
      let sandbox = await sandboxes.create(input.files, input.signal);
      try {
        await buildRepository(sandbox, input.files, input.event);
        const application = applicationFromFiles(await sandbox.files());
        const suite: ExternalSuiteReport = {
          schema_version: "1.0",
          suite_id: input.id,
          created_at: now().toISOString(),
          environment: "simulation",
          model_execution: "openai",
          application,
          provenance: {
            version: 1,
            evaluator_version: FINANCIAL_EVALUATOR_VERSION,
            scenarios: input.scenarios.map(scenarioProvenance),
            trials_per_scenario: 1,
            timeout_ms: 120000,
            model_configuration: {
              provider: "openai",
              model: input.model,
              execution: "openai",
              verified: false,
            },
            trial_matrix: input.scenarios.map((scenario) => ({
              scenario_id: scenario.id,
              run_number: 1,
              task_expectation: scenario.task_expectation ?? "complete",
            })),
          },
          runs: [],
          decision: "allow",
        };
        for (const scenario of input.scenarios) {
          input.signal.throwIfAborted();
          if (suite.runs.length > 0) {
            await sandbox.close();
            sandbox = await sandboxes.create(input.files, input.signal);
            await buildRepository(sandbox, input.files, input.event);
            if (
              applicationFromFiles(await sandbox.files()).contentHash !==
              application.contentHash
            )
              throw new PlatformError(
                422,
                "The build changed between clean trials. Make the build reproducible before evaluating.",
              );
          }
          await input.event(
            "evaluating",
            `Running ${scenario.name}. ${suite.runs.length} of ${input.scenarios.length} tests completed.`,
          );
          const report = createRunReport(
            await runScenario({
              scenario: { ...scenario, agent: { adapter: application.id } },
              agent: new ExternalProcessAgent({
                application,
                apiKey,
                model: input.model,
                timeoutMs: 120000,
                signal: input.signal,
                launch: sandbox.launch,
              }),
              run_number: 1,
              capture_agent_failures: true,
              timer: new SystemMonotonicTimer(),
            }),
          );
          if (
            applicationFromFiles(await sandbox.files()).contentHash !==
            application.contentHash
          )
            throw new PlatformError(
              422,
              "Application files changed during evaluation. These results cannot verify the candidate.",
            );
          suite.runs.push({
            report_path: `runs/${input.id}/${report.run_id}`,
            report,
          });
          if (report.result !== "pass") suite.decision = "block";
        }
        input.signal.throwIfAborted();
        suite.completed_at = now().toISOString();
        suite.provenance.model_configuration = verifiedConfiguration(suite);
        return suite;
      } finally {
        await sandbox.close();
      }
    },
  };
}
