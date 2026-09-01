#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { compareCommand } from "./commands/compare.js";
import { experimentCommand } from "./commands/experiment.js";
import { promoteCommand } from "./commands/promote.js";
import { regressCommand } from "./commands/regress.js";
import { type CommandIo, runScenarioCommand } from "./commands/run.js";

const defaultIo: CommandIo = {
  stdout(message) {
    process.stdout.write(`${message}\n`);
  },
  stderr(message) {
    process.stderr.write(`${message}\n`);
  },
};

export async function main(
  argv = process.argv,
  cwd = process.cwd(),
  io: CommandIo = defaultIo,
): Promise<number> {
  let commandExitCode = 0;
  const program = new Command();
  program
    .name("eigen")
    .description("Deterministic financial evaluation for payment agents")
    .version("0.1.0")
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    });

  program
    .command("promote")
    .description("Promote a failed trace into a permanent regression")
    .argument("<trace-path>", "path to a failed Eigen trace")
    .requiredOption("--name <regression-name>", "lowercase regression slug")
    .action(async (tracePath: string, commandOptions: { name: string }) => {
      const outcome = await promoteCommand({
        tracePath,
        name: commandOptions.name,
        cwd,
        io,
      });
      commandExitCode = outcome.exitCode;
    });

  program
    .command("regress")
    .description("Run a promoted regression against two agent profiles")
    .argument("<regression-manifest>", "path to a regression manifest")
    .requiredOption("--agents <agent-names>", "baseline and candidate profiles")
    .requiredOption("--runs <number>", "runs per agent")
    .action(
      async (
        manifestPath: string,
        commandOptions: { agents: string; runs: string },
      ) => {
        const outcome = await regressCommand({
          manifestPath,
          agentNames: commandOptions.agents,
          runs: commandOptions.runs,
          cwd,
          io,
        });
        commandExitCode = outcome.exitCode;
      },
    );

  program
    .command("experiment")
    .description("Repeat live LLM agents across a scenario directory")
    .argument("<scenario-directory>", "directory containing YAML scenarios")
    .requiredOption(
      "--agents <agent-names>",
      "two comma-separated agent profiles",
    )
    .requiredOption("--runs <number>", "runs per scenario")
    .option(
      "--allow-failures",
      "return success while preserving BLOCK decisions",
      false,
    )
    .action(
      async (
        scenarioDirectory: string,
        commandOptions: {
          agents: string;
          runs: string;
          allowFailures: boolean;
        },
      ) => {
        const outcome = await experimentCommand({
          scenarioDirectory,
          agentNames: commandOptions.agents,
          runs: commandOptions.runs,
          allowFailures: commandOptions.allowFailures,
          cwd,
          io,
        });
        commandExitCode = outcome.exitCode;
      },
    );

  program
    .command("compare")
    .description("Compare two agents across a scenario directory")
    .argument("<scenario-directory>", "directory containing YAML scenarios")
    .requiredOption("--baseline <agent-name>", "baseline agent adapter")
    .requiredOption("--candidate <agent-name>", "candidate agent adapter")
    .action(
      async (
        scenarioDirectory: string,
        commandOptions: { baseline: string; candidate: string },
      ) => {
        const outcome = await compareCommand({
          scenarioDirectory,
          baselineName: commandOptions.baseline,
          candidateName: commandOptions.candidate,
          cwd,
          io,
        });
        commandExitCode = outcome.exitCode;
      },
    );

  program
    .command("run")
    .description("Run one payment-agent scenario")
    .argument("<scenario-path>", "path to a YAML scenario")
    .requiredOption("--agent <agent-name>", "agent adapter to run")
    .action(async (scenarioPath: string, commandOptions: { agent: string }) => {
      const outcome = await runScenarioCommand({
        scenarioPath,
        agentName: commandOptions.agent,
        cwd,
        io,
      });
      commandExitCode = outcome.exitCode;
    });

  try {
    await program.parseAsync(argv);
    return commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return 0;
      }
      if (argv[2] === "experiment") return 1;
      if (argv[2] === "promote" || argv[2] === "regress") return 2;
      return 2;
    }
    throw error;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectExecution) {
  process.exitCode = await main();
}
