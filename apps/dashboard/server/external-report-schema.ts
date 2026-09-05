import { z } from "zod";

const text = z.string().min(1);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = count;
const timestamp = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const object = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).passthrough();
const record = z.record(z.string(), z.unknown());
const decision = z.enum(["allow", "block"]);
const result = z.enum(["pass", "fail"]);
const claimSource = z.enum(["agent", "eigen_failure_fallback"]);

export const externalPaymentSchema = object({
  id: text,
  amount: money,
  currency,
  status: z.enum(["created", "authorized", "captured", "refunded", "failed"]),
  refunded_amount: money,
});
export const externalRefundSchema = object({
  id: text,
  payment_id: text,
  amount: money,
  currency,
  status: z.enum(["pending", "processed", "failed"]),
  request_id: text,
  action_key: text,
  mandate_id: text,
  purpose: text,
  semantic_fingerprint: text,
  created_at: timestamp,
});
const world = object({
  payments: z.array(externalPaymentSchema),
  refunds: z.array(externalRefundSchema),
}).superRefine((snapshot, context) => {
  for (const collection of ["payments", "refunds"] as const) {
    const ids = new Set<string>();
    for (const [index, resource] of snapshot[collection].entries()) {
      if (ids.has(resource.id))
        context.addIssue({
          code: "custom",
          path: [collection, index, "id"],
          message: "Resource IDs must be unique within each world snapshot.",
        });
      ids.add(resource.id);
    }
  }
});
const mandate = object({
  id: text,
  action: z.literal("create_refund"),
  resource_id: text,
  maximum_amount: money,
  currency,
  maximum_executions: count,
  approval_required: z.boolean(),
  purpose: text,
  expires_at: timestamp.optional(),
});
const claim = object({
  status: z.enum(["completed", "pending", "failed", "unknown"]),
  paymentId: text,
  refundIds: z.array(text),
  amount: money,
  currency,
  message: z.string(),
});
const finding = object({
  code: text,
  category: text,
  severity: z.enum(["info", "warning", "critical"]),
  title: text,
  explanation: text,
  evidence_event_ids: z.array(text),
  affected_resources: z.array(text),
  expected_state: record,
  observed_state: record,
  remediation_hint: z.string().optional(),
});
const metrics = object({
  latency_ms: z.number().nonnegative(),
  model_requests: count,
  tool_calls: count,
  input_tokens: count.optional(),
  output_tokens: count.optional(),
  token_usage_available: z.boolean(),
});
const fault = object({
  type: z.enum(["timeout_after_side_effect", "timeout_before_side_effect"]),
  operation: z.literal("create_refund"),
  occurrence: count.positive(),
});
const operation = z.literal("create_refund");
const call = { operation, call_id: text };
export const knownTracePayloadSchemas = {
  "scenario.started": object({
    scenario_id: text,
    seed: z.number().int(),
    agent_id: text,
    run_number: count.positive().optional(),
  }),
  "user.task.received": object({
    task: object({
      type: z.literal("refund_payment"),
      payment_id: text,
      amount: money,
      currency,
      purpose: text,
    }),
  }),
  "mandate.loaded": object({ mandate }),
  "agent.message": object({ message: z.string() }),
  "agent.configuration.loaded": object({
    model: text,
    prompt_profile: text,
    prompt_hash: text,
    tool_manifest_hash: text,
  }),
  "model.request.started": object({
    request_id: text,
    model: text,
    turn: count.positive(),
  }),
  "model.request.finished": object({
    request_id: text,
    model: text,
    turn: count.positive(),
    outcome: z.enum(["success", "error"]),
    latency_ms: z.number().nonnegative(),
    input_tokens: count.optional(),
    output_tokens: count.optional(),
    error_code: text.optional(),
  }),
  "model.tool.selected": object({
    tool_name: text,
    tool_call_id: text,
    arguments: record,
  }),
  "model.tool.result": object({
    tool_name: text,
    tool_call_id: text,
    result: z.unknown(),
  }),
  "payment.read.requested": object({ payment_id: text, call_id: text }),
  "payment.read.returned": object({
    payment: externalPaymentSchema,
    call_id: text,
  }),
  "payment.read.failed": object({
    payment_id: text,
    call_id: text,
    error_code: text,
  }),
  "tool.call.requested": object({
    ...call,
    request_id: text,
    action_key: text,
    semantic_fingerprint: text,
    input: object({ payment_id: text, amount: money, currency, purpose: text }),
  }),
  "tool.call.accepted": object(call),
  "tool.call.rejected": object({ ...call, reason: text }),
  "tool.response.returned": object({ ...call, output: externalRefundSchema }),
  "tool.error.returned": object({
    ...call,
    error_code: text,
    ambiguous: z.boolean(),
    message: text,
  }),
  "payment.refund.created": object({
    refund: externalRefundSchema,
    payment_refunded_amount: money,
  }),
  "payment.refund.observed": object({
    refund: externalRefundSchema,
    source: z.literal("reconciliation"),
  }),
  "payment.refund.deduplicated": object({
    refund: externalRefundSchema,
    action_key: text,
  }),
  "fault.injected": object({ ...call, fault, refund_id: text.optional() }),
  "agent.retry": object({
    operation,
    previous_call_id: text,
    semantic_fingerprint: text,
    action_key: text,
  }),
  "agent.reconciliation.started": object({
    payment_id: text,
    semantic_action_key: text,
  }),
  "agent.reconciliation.completed": object({
    payment_id: text,
    semantic_action_key: text,
    matching_refund_ids: z.array(text),
  }),
  "agent.final_claim": object({ claim, source: claimSource }),
  "agent.run.failed": object({ error_code: text, message: text }),
  "world.snapshot": object({ snapshot: world }),
  "evaluator.finding": object({ finding }),
  "run.metrics": metrics,
  "run.completed": object({ result, deployment_decision: decision }),
};
export const externalTraceEventSchema = object({
  id: text,
  sequence: count.positive(),
  timestamp,
  type: text,
  correlation_id: text.optional(),
  payload: record,
}).superRefine((event, context) => {
  if (!Object.hasOwn(knownTracePayloadSchemas, event.type)) return;
  const schema =
    knownTracePayloadSchemas[
      event.type as keyof typeof knownTracePayloadSchemas
    ];
  if (!schema) return;
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["payload", ...issue.path],
        message: issue.message,
      });
    }
});
const categoryCounts = object({
  financial_safety: count,
  reliability: count,
  truthfulness: count,
  calibration: count,
  trace_integrity: count,
});
export const externalRunReportSchema = object({
  schema_version: z.literal("1.1"),
  run_id: text,
  scenario_id: text,
  scenario_name: text,
  seed: z.number().int(),
  task_expectation: z.enum(["complete", "refuse"]).optional(),
  evaluator_version: text.optional(),
  agent_id: text,
  started_at: timestamp,
  completed_at: timestamp,
  mandate,
  initial_world: world,
  final_world: world,
  final_claim: claim,
  final_claim_source: claimSource,
  run_number: count.positive(),
  agent_error: object({ code: text, message: text }).optional(),
  metrics: metrics.optional(),
  trace: z.array(externalTraceEventSchema).min(1),
  findings: z.array(finding),
  result,
  deployment_decision: decision,
  summary: object({
    refund_count: count,
    total_refunded: money,
    critical_finding_count: count,
    findings_by_category: categoryCounts,
  }),
}).superRefine((run, context) => {
  // Financial TRACE_INCOMPLETE findings remain inspectable. Completion is a
  // separate recorder marker emitted after evaluation, including failed runs.
  const completions = run.trace.filter(
    (event) => event.type === "run.completed",
  );
  if (completions.length === 0)
    context.addIssue({
      code: "custom",
      path: ["trace"],
      params: { availability: "incomplete" },
      message: "The run completion marker is missing.",
    });
  if (completions.length > 1)
    context.addIssue({
      code: "custom",
      path: ["trace"],
      message: "A run must contain exactly one completion marker.",
    });
  const completion = completions[0];
  if (
    completion &&
    (completion.payload.result !== run.result ||
      completion.payload.deployment_decision !== run.deployment_decision ||
      Date.parse(completion.timestamp) !== Date.parse(run.completed_at))
  ) {
    context.addIssue({
      code: "custom",
      path: ["trace"],
      message:
        "The completion marker must match the recorded run outcome and completion time.",
    });
  }
  const ids = new Set<string>();
  let previous = 0;
  for (const [index, event] of run.trace.entries()) {
    if (ids.has(event.id))
      context.addIssue({
        code: "custom",
        path: ["trace", index, "id"],
        message: "Trace event IDs must be unique within a run.",
      });
    if (event.sequence <= previous)
      context.addIssue({
        code: "custom",
        path: ["trace", index, "sequence"],
        message: "Trace sequences must be unique and increasing.",
      });
    ids.add(event.id);
    previous = event.sequence;
  }
});
export const externalSuiteReportSchema = object({
  schema_version: z.literal("1.0"),
  suite_id: text,
  created_at: timestamp.optional(),
  completed_at: timestamp.optional(),
  environment: z.literal("simulation"),
  model_execution: z.enum(["openai", "test_double"]),
  // Comparison metadata is parsed separately: incomplete provenance must not
  // make otherwise valid saved financial evidence disappear.
  provenance: z.unknown().optional(),
  application: object({
    directory: text,
    id: text,
    entrypoint: text,
    files: z.record(text, sha256),
    contentHash: sha256,
  }),
  runs: z
    .array(object({ report_path: text, report: externalRunReportSchema }))
    .min(1),
  decision,
}).superRefine((suite, context) => {
  const identities = new Set<string>();
  const scenarioNames = new Map<string, string>();
  for (const [index, { report }] of suite.runs.entries()) {
    if (report.agent_id !== suite.application.id)
      context.addIssue({
        code: "custom",
        path: ["runs", index, "report", "agent_id"],
        message: "The embedded run agent must match the suite application.",
      });
    const priorName = scenarioNames.get(report.scenario_id);
    if (priorName !== undefined && priorName !== report.scenario_name)
      context.addIssue({
        code: "custom",
        path: ["runs", index, "report", "scenario_name"],
        message: "Runs for one scenario ID must use the same scenario name.",
      });
    scenarioNames.set(report.scenario_id, report.scenario_name);
    const key = JSON.stringify([report.scenario_id, report.run_number]);
    if (identities.has(key))
      context.addIssue({
        code: "custom",
        path: ["runs", index],
        message: "Scenario and run number must identify a unique suite run.",
      });
    identities.add(key);
  }
});
export type ExternalSuiteReport = z.infer<typeof externalSuiteReportSchema>;
export type ExternalRunReport = z.infer<typeof externalRunReportSchema>;
export type ExternalTraceEvent = z.infer<typeof externalTraceEventSchema>;

const taskExpectation = z.enum(["complete", "refuse"]);
export const externalComparisonProvenanceSchema = object({
  version: z.literal(1),
  reviewed_suite_id: text.optional(),
  evaluator_version: text,
  scenarios: z
    .array(
      object({
        scenario_id: text,
        content_hash: sha256,
        task_expectation: taskExpectation,
        scenario: object({
          id: text,
          name: text,
          seed: z.number().int(),
          user_task: object({
            type: z.literal("refund_payment"),
            payment_id: text,
            amount: money,
            currency,
            purpose: text,
          }),
          mandate,
          initial_world: object({ payments: z.array(externalPaymentSchema) }),
          faults: z.array(fault),
          task_expectation: taskExpectation,
        }),
      }),
    )
    .min(1),
  trials_per_scenario: count.positive(),
  timeout_ms: count.positive(),
  model_configuration: object({
    provider: z.literal("openai"),
    model: text,
    execution: z.enum(["openai", "test_double"]),
    verified: z.boolean(),
    settings: object({
      settings_version: z.literal(1),
      model: text,
      store: z.boolean(),
      max_output_tokens: count.positive(),
      parallel_tool_calls: z.boolean(),
      additional_parameters: record.optional(),
    }).optional(),
    execution_policy: object({
      max_turns: count.positive(),
      model_timeout_ms: count.positive(),
    }).optional(),
  }),
  trial_matrix: z
    .array(
      object({
        scenario_id: text,
        run_number: count.positive(),
        task_expectation: taskExpectation,
      }),
    )
    .min(1),
});

export type ExternalComparisonProvenance = z.infer<
  typeof externalComparisonProvenanceSchema
>;
