import { z } from "zod";
import { faultSpecSchema } from "../domain/index.js";

const identifierSchema = z.string().trim().min(1);
const relativePathSchema = identifierSchema.refine(
  (value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."),
  "path must be relative and must not contain parent traversal",
);

export const regressionNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be a lowercase slug");

export const regressionManifestSchema = z
  .object({
    schema_version: z.literal("1.0"),
    name: regressionNameSchema,
    source_trace: relativePathSchema,
    archived_source_trace: relativePathSchema,
    source_trace_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    scenario: relativePathSchema,
    source_agent_profile: identifierSchema,
    source_model: identifierSchema,
    source_prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_tool_manifest_hash: z.string().regex(/^[a-f0-9]{64}$/),
    deterministic_world_seed: z.number().int().nonnegative(),
    fault_configuration: z.array(faultSpecSchema),
    original_findings: z.array(identifierSchema).min(1),
    required_invariants: z.object({
      required_refund: z.object({
        count: z.literal(1),
        payment_id: identifierSchema,
        amount: z.number().int().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        purpose: identifierSchema,
      }),
      required_final_status: z.literal("completed"),
      final_claim_must_match_authoritative_state: z.literal(true),
    }),
    minimum_repeated_runs: z.number().int().positive(),
    permitted_financial_safety_violations: z.number().int().nonnegative(),
    permitted_reliability_failures: z.number().int().nonnegative(),
    required_pass_rate: z.number().min(0).max(100),
  })
  .strict();

export function parseRegressionManifest(input: unknown) {
  return regressionManifestSchema.parse(input);
}

const historicalFindingSchema = z
  .object({ code: identifierSchema })
  .passthrough();
const historicalTraceEventSchema = z
  .object({
    type: identifierSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const promotableTraceSchema = z
  .object({
    schema_version: z.enum(["1.0", "1.1"]),
    scenario_id: identifierSchema,
    seed: z.number().int().nonnegative(),
    agent_id: identifierSchema,
    result: z.literal("fail"),
    findings: z.array(historicalFindingSchema).min(1),
    trace: z.array(historicalTraceEventSchema),
  })
  .passthrough();

export interface PromotableTrace {
  scenarioId: string;
  seed: number;
  agentProfile: string;
  model: string;
  promptHash: string;
  toolManifestHash: string;
  originalFindings: string[];
  observedFaults: unknown[];
}

export function parsePromotableTrace(input: unknown): PromotableTrace {
  const report = promotableTraceSchema.parse(input);
  const configurations = report.trace.filter(
    (event) => event.type === "agent.configuration.loaded",
  );
  if (configurations.length !== 1) {
    throw new Error(
      "The source trace must contain exactly one agent configuration event",
    );
  }
  const configuration = z
    .object({
      model: identifierSchema,
      prompt_profile: identifierSchema,
      prompt_hash: z.string().regex(/^[a-f0-9]{64}$/),
      tool_manifest_hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(configurations[0]?.payload);
  if (configuration.prompt_profile !== report.agent_id) {
    throw new Error("The source trace agent profile is inconsistent");
  }
  return {
    scenarioId: report.scenario_id,
    seed: report.seed,
    agentProfile: configuration.prompt_profile,
    model: configuration.model,
    promptHash: configuration.prompt_hash,
    toolManifestHash: configuration.tool_manifest_hash,
    originalFindings: report.findings.map((finding) => finding.code),
    observedFaults: report.trace.flatMap((event) =>
      event.type === "fault.injected" && "fault" in event.payload
        ? [event.payload.fault]
        : [],
    ),
  };
}
