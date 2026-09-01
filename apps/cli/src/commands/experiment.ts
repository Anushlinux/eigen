import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type AgentAdapter,
  formatExperimentReport,
  type MonotonicTimer,
  runExperiment,
  SystemMonotonicTimer,
} from "@eigen/core";
import {
  createLiveOpenAIRefundAgent,
  isOpenAIRefundProfileId,
  type OpenAIEnvironment,
  validateOpenAIEnvironment,
} from "@eigen/openai-adapter";
import { loadScenarios } from "./compare.js";
import type { CommandIo } from "./run.js";

export interface ExperimentCommandOptions {
  scenarioDirectory: string;
  agentNames: string;
  runs: string;
  allowFailures: boolean;
  cwd: string;
  io: CommandIo;
}

export interface ExperimentCommandDependencies {
  environment: OpenAIEnvironment;
  createAgent(profileId: string): AgentAdapter;
  now(): string;
  nextId(prefix: string): string;
  createTimer(): MonotonicTimer;
}

function defaultDependencies(
  environment: OpenAIEnvironment,
): ExperimentCommandDependencies {
  return {
    environment,
    createAgent(profileId) {
      return createLiveOpenAIRefundAgent(profileId, environment);
    },
    now() {
      return new Date().toISOString();
    },
    nextId(prefix) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      return `${prefix}_${timestamp}_${randomUUID().slice(0, 8)}`;
    },
    createTimer() {
      return new SystemMonotonicTimer();
    },
  };
}

function parseAgentNames(value: string): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => name.length === 0)) {
    throw new Error("--agents must not contain empty names");
  }
  if (names.length !== 2) {
    throw new Error("--agents must contain exactly two profiles");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("--agents must not contain duplicate profiles");
  }
  for (const name of names) {
    if (!isOpenAIRefundProfileId(name)) {
      throw new Error(`Unknown experiment agent: ${name}`);
    }
  }
  return names;
}

export async function experimentCommand(
  options: ExperimentCommandOptions,
  injectedDependencies?: ExperimentCommandDependencies,
): Promise<{ exitCode: 0 | 1 }> {
  const dependencies = injectedDependencies ?? defaultDependencies(process.env);
  try {
    const agentNames = parseAgentNames(options.agentNames);
    const runs = Number(options.runs);
    if (!Number.isInteger(runs) || runs <= 0) {
      throw new Error("--runs must be a positive integer");
    }
    validateOpenAIEnvironment(dependencies.environment);
    const absoluteDirectory = resolve(options.cwd, options.scenarioDirectory);
    const scenarios = await loadScenarios(absoluteDirectory);
    const report = await runExperiment({
      scenarios,
      scenarioDirectory: options.scenarioDirectory,
      agents: agentNames.map((agentName) => ({
        id: agentName,
        create: () => dependencies.createAgent(agentName),
      })),
      runs,
      reportsDirectory: resolve(options.cwd, "reports"),
      reportPathPrefix: "reports",
      dependencies: {
        now: dependencies.now,
        nextId: dependencies.nextId,
        createTimer: dependencies.createTimer,
      },
    });
    options.io.stdout(formatExperimentReport(report));
    const hasBlockedAgent = report.agents.some(
      (agent) => agent.decision === "block",
    );
    return {
      exitCode: hasBlockedAgent && !options.allowFailures ? 1 : 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.io.stderr(`Eigen could not run the experiment: ${message}`);
    return { exitCode: 1 };
  }
}
