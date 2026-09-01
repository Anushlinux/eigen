import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AgentAdapter,
  formatRegressionReport,
  type MonotonicTimer,
  parseRegressionManifest,
  parseScenario,
  runRegression,
  SystemMonotonicTimer,
} from "@eigen/core";
import {
  createLiveOpenAIRefundAgent,
  isOpenAIRefundProfileId,
  type OpenAIEnvironment,
  validateOpenAIEnvironment,
} from "@eigen/openai-adapter";
import { parse as parseYaml } from "yaml";
import type { CommandIo } from "./run.js";

export interface RegressCommandOptions {
  manifestPath: string;
  agentNames: string;
  runs: string;
  cwd: string;
  io: CommandIo;
}

export interface RegressionCommandDependencies {
  environment: OpenAIEnvironment;
  createAgent(profileId: string): AgentAdapter;
  now(): string;
  nextId(prefix: string): string;
  createTimer(): MonotonicTimer;
}

function defaultDependencies(
  environment: OpenAIEnvironment,
): RegressionCommandDependencies {
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
  if (names.length !== 2 || names.some((name) => name.length === 0)) {
    throw new Error("--agents must contain exactly two profiles");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("--agents must not contain duplicate profiles");
  }
  for (const name of names) {
    if (!isOpenAIRefundProfileId(name)) {
      throw new Error(`Unknown regression agent: ${name}`);
    }
  }
  return names;
}

export async function regressCommand(
  options: RegressCommandOptions,
  injectedDependencies?: RegressionCommandDependencies,
): Promise<{ exitCode: 0 | 1 | 2 }> {
  const dependencies = injectedDependencies ?? defaultDependencies(process.env);
  try {
    const agentNames = parseAgentNames(options.agentNames);
    const runs = Number(options.runs);
    if (!Number.isInteger(runs) || runs <= 0) {
      throw new Error("--runs must be a positive integer");
    }
    validateOpenAIEnvironment(dependencies.environment);
    const absoluteManifestPath = resolve(options.cwd, options.manifestPath);
    const manifest = parseRegressionManifest(
      parseYaml(await readFile(absoluteManifestPath, "utf8")),
    );
    const archivedEvidence = await readFile(
      resolve(options.cwd, manifest.archived_source_trace),
    );
    const archiveHash = createHash("sha256")
      .update(archivedEvidence)
      .digest("hex");
    if (archiveHash !== manifest.source_trace_sha256) {
      throw new Error("The archived source trace checksum does not match");
    }
    const scenario = parseScenario(
      parseYaml(
        await readFile(resolve(options.cwd, manifest.scenario), "utf8"),
      ),
    );
    const report = await runRegression({
      manifest,
      manifestPath: options.manifestPath,
      scenario,
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
    options.io.stdout(formatRegressionReport(report));
    return { exitCode: report.candidate_status === "VERIFIED" ? 0 : 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.io.stderr(`Eigen could not run the regression: ${message}`);
    return { exitCode: 2 };
  }
}
