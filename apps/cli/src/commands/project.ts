import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createProject,
  type ExternalExecutionDependencies,
  executeExternalSuite,
  loadExternalApplication,
  PROJECT_FILE,
  REVIEWED_SUITE_ID,
  readProject,
  requireProject,
  reviewedSuiteDirectory,
  scenarioSetHash,
  validateReviewedSuite,
} from "@eigen/external-runner";
import type { CommandIo } from "./run.js";

export interface InitOptions {
  app: string;
  entrypoint?: string;
  suiteDirectory?: string;
  model?: string;
  trials: string;
  timeoutMs: string;
}
export async function initProjectCommand(
  cwd: string,
  flags: InitOptions,
  io: CommandIo,
  environment = process.env,
): Promise<number> {
  try {
    const directory = resolve(cwd, flags.app);
    let entrypoint = flags.entrypoint;
    if (!entrypoint) {
      try {
        entrypoint = JSON.parse(
          await readFile(resolve(directory, "eigen.json"), "utf8"),
        ).entrypoint;
      } catch {
        throw new Error(
          "The application needs an eigen.json integration manifest. Add its Node entrypoint and declared source files, or supply --entrypoint to prepare the project before integration. See docs/milestone-4.md.",
        );
      }
    }
    const model = flags.model ?? environment.OPENAI_MODEL;
    if (!model?.trim())
      throw new Error(
        "Choose --model <name> or set OPENAI_MODEL before setup.",
      );
    await createProject(cwd, {
      version: 1,
      application: { directory, entrypoint },
      suite: {
        id: REVIEWED_SUITE_ID,
        directory: resolve(cwd, flags.suiteDirectory ?? reviewedSuiteDirectory),
      },
      model: { name: model },
      execution: {
        trials: Number(flags.trials),
        timeoutMs: Number(flags.timeoutMs),
      },
    });
    io.stdout(
      `Created ${PROJECT_FILE}. Application source was not changed or executed. No inference was used. Build your application, then run eigen doctor.`,
    );
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    io.stderr(
      code === "EEXIST"
        ? `${PROJECT_FILE} already exists; it was not overwritten. Edit it to change the connected application.`
        : "Setup failed. Check the application manifest or --entrypoint, model name, trials (1–3), and timeout (100–300000 ms). See docs/milestone-4.md.",
    );
    return 2;
  }
}

export async function doctorCommand(
  cwd: string,
  io: CommandIo,
  execute: boolean,
  dependencies: ExternalExecutionDependencies = { environment: process.env },
): Promise<number> {
  io.stdout(
    "Static setup checks — application code is not executed; no model inference or payment calls.",
  );
  let project: Awaited<ReturnType<typeof readProject>>;
  try {
    project = await readProject(cwd);
    if (!project)
      throw new Error(
        `Missing ${PROJECT_FILE}. Run eigen init --app <directory>.`,
      );
    io.stdout(
      "PASS Project configuration: valid version and bounded execution settings.",
    );
  } catch (error) {
    io.stderr(
      error instanceof Error
        ? error.message
        : "Project configuration unavailable.",
    );
    return 2;
  }
  let ready = true;
  try {
    const app = await loadExternalApplication(
      resolve(cwd, project.application.directory),
    );
    if (app.entrypoint !== project.application.entrypoint)
      throw new Error("Entrypoint mismatch");
    io.stdout(
      `PASS Application build: ${app.id}; ${app.entrypoint}; hash ${app.contentHash}. Files exist; this does not prove the build is current or the protocol works.`,
    );
  } catch {
    ready = false;
    io.stderr(
      "FAIL Application build: check eigen.json, declared source files, dist/*.js, and the configured entrypoint. Rebuild the application. The adapter must accept one JSON task on stdin, emit Eigen protocol events on stdout, and use the simulator payment URL/token.",
    );
  }
  try {
    await validateReviewedSuite(resolve(cwd, project.suite.directory));
    io.stdout(
      "PASS Reviewed suite: the six configured scenarios match the shipped suite.",
    );
  } catch {
    ready = false;
    io.stderr(
      "FAIL Reviewed suite: restore the six shipped refund scenarios and check the configured directory.",
    );
  }
  if (!dependencies.environment.OPENAI_API_KEY?.trim()) {
    ready = false;
    io.stderr(
      "FAIL Inference configuration: OPENAI_API_KEY is missing from the server environment.",
    );
  } else
    io.stdout(
      `PASS Inference configuration: a key is present and model ${project.model.name} is selected. Credential validity and model access have not been tested.`,
    );
  if (!ready) return 2;
  if (!execute) {
    io.stdout(
      "Static setup is ready. For an execution check, use eigen doctor --execute. It runs the configured reviewed suite with live OpenAI inference and simulated payments, saves evidence, and can incur inference charges. The dashboard and eigen evaluate use the same runner.",
    );
    return 0;
  }
  return evaluateProjectCommand(cwd, io, undefined, dependencies);
}

export async function evaluateProjectCommand(
  cwd: string,
  io: CommandIo,
  runs?: string,
  dependencies: ExternalExecutionDependencies = { environment: process.env },
): Promise<number> {
  try {
    const selected = await requireProject(cwd);
    const trials =
      runs === undefined ? selected.project.execution.trials : Number(runs);
    if (!Number.isInteger(trials) || trials < 1 || trials > 3)
      throw new Error("Trials must be 1–3.");
    io.stdout(
      `Execution check: ${selected.application.id}; 6 scenarios × ${trials} trials; ${dependencies.modelBaseUrl ? "offline model double" : "live OpenAI inference"}; simulated payments.`,
    );
    const suite = await executeExternalSuite(
      {
        cwd,
        appDirectory: selected.application.directory,
        scenarioDirectory: selected.scenarioDirectory,
        expectedApplicationHash: selected.application.contentHash,
        expectedScenarioHash: scenarioSetHash(selected.scenarios),
        reviewedSuiteId: REVIEWED_SUITE_ID,
        runs: trials,
        timeoutMs: selected.project.execution.timeoutMs,
        onReport: (report) =>
          io.stdout(
            `${report.scenario_id}: ${report.result.toUpperCase()}${report.agent_error ? ` (${report.agent_error.code})` : ""}`,
          ),
      },
      {
        ...dependencies,
        environment: {
          OPENAI_API_KEY: dependencies.environment.OPENAI_API_KEY,
          OPENAI_MODEL: selected.project.model.name,
        },
      },
    );
    io.stdout(
      `Saved reports/external/${suite.suite_id}/suite.json. Decision: ${suite.decision.toUpperCase()}.`,
    );
    return suite.decision === "allow" ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown integration error";
    const secret = dependencies.environment.OPENAI_API_KEY;
    io.stderr(secret ? message.split(secret).join("[REDACTED]") : message);
    return 2;
  }
}
