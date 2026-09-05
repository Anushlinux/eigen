export type Currency = string;

export interface Payment {
  id: string;
  amount: number;
  currency: Currency;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  refunded_amount: number;
}

export interface Refund {
  id: string;
  payment_id: string;
  amount: number;
  currency: Currency;
  status: "pending" | "processed" | "failed";
  request_id: string;
  action_key: string;
  mandate_id: string;
  purpose: string;
  semantic_fingerprint: string;
  created_at: string;
}

export interface WorldSnapshot {
  payments: Payment[];
  refunds: Refund[];
}

export interface UserTask {
  type: "refund_payment";
  payment_id: string;
  amount: number;
  currency: Currency;
  purpose: string;
}

export interface Mandate {
  id: string;
  action: "create_refund";
  resource_id: string;
  maximum_amount: number;
  currency: Currency;
  maximum_executions: number;
  approval_required: boolean;
  purpose: string;
  expires_at?: string | undefined;
}

export interface FaultSpec {
  type: "timeout_after_side_effect" | "timeout_before_side_effect";
  operation: "create_refund";
  occurrence: number;
}

export interface AgentClaim {
  status: "completed" | "pending" | "failed" | "unknown";
  paymentId: string;
  refundIds: string[];
  amount: number;
  currency: Currency;
  message: string;
}

export interface ScenarioExpected {
  result: "pass" | "fail";
  critical_findings: FindingCode[];
  final_world: {
    refund_count: number;
    total_refunded: number;
  };
}

export interface Scenario {
  id: string;
  name: string;
  seed: number;
  agent: {
    adapter: string;
  };
  initial_world: {
    payments: Payment[];
  };
  user_task: UserTask;
  mandate: Mandate;
  faults: FaultSpec[];
  expected?: ScenarioExpected | undefined;
  metadata?: Record<string, string> | undefined;
  tags?: string[] | undefined;
}

export type FindingCode =
  | "MANDATE_AMOUNT_EXCEEDED"
  | "MANDATE_EXECUTION_COUNT_EXCEEDED"
  | "DUPLICATE_FINANCIAL_EFFECT"
  | "REQUIRED_FINANCIAL_EFFECT_MISSING"
  | "PAYMENT_STATE_TRUTH_MISMATCH"
  | "KNOWN_STATE_REPORTED_UNKNOWN"
  | "TRACE_INCOMPLETE";

export type FindingCategory =
  | "financial_safety"
  | "reliability"
  | "truthfulness"
  | "calibration"
  | "trace_integrity";

export interface Finding {
  code: FindingCode;
  category: FindingCategory;
  severity: "info" | "warning" | "critical";
  title: string;
  explanation: string;
  evidence_event_ids: string[];
  affected_resources: string[];
  expected_state: Record<string, unknown>;
  observed_state: Record<string, unknown>;
  remediation_hint?: string | undefined;
}

export interface TracePayloadMap {
  "scenario.started": {
    scenario_id: string;
    seed: number;
    agent_id: string;
    run_number?: number | undefined;
  };
  "user.task.received": { task: UserTask };
  "mandate.loaded": { mandate: Mandate };
  "agent.message": { message: string };
  "agent.configuration.loaded": {
    model: string;
    prompt_profile: string;
    prompt_hash: string;
    tool_manifest_hash: string;
  };
  "model.request.started": {
    request_id: string;
    model: string;
    turn: number;
  };
  "model.request.finished": {
    request_id: string;
    model: string;
    turn: number;
    outcome: "success" | "error";
    latency_ms: number;
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    error_code?: string | undefined;
  };
  "model.tool.selected": {
    tool_name: string;
    tool_call_id: string;
    arguments: Record<string, unknown>;
  };
  "model.tool.result": {
    tool_name: string;
    tool_call_id: string;
    result: unknown;
  };
  "agent.retry": {
    operation: "create_refund";
    previous_call_id: string;
    semantic_fingerprint: string;
    action_key: string;
  };
  "agent.reconciliation.started": {
    payment_id: string;
    semantic_action_key: string;
  };
  "agent.reconciliation.completed": {
    payment_id: string;
    semantic_action_key: string;
    matching_refund_ids: string[];
  };
  "tool.call.requested": {
    operation: "create_refund";
    call_id: string;
    request_id: string;
    action_key: string;
    input: {
      payment_id: string;
      amount: number;
      currency: Currency;
      purpose: string;
    };
    semantic_fingerprint: string;
  };
  "tool.call.accepted": {
    operation: "create_refund";
    call_id: string;
  };
  "tool.call.rejected": {
    operation: "create_refund";
    call_id: string;
    reason: string;
  };
  "payment.refund.created": {
    refund: Refund;
    payment_refunded_amount: number;
  };
  "payment.refund.observed": {
    refund: Refund;
    source: "reconciliation";
  };
  "payment.refund.deduplicated": {
    refund: Refund;
    action_key: string;
  };
  "fault.injected": {
    fault: FaultSpec;
    operation: "create_refund";
    call_id: string;
    refund_id?: string | undefined;
  };
  "tool.response.returned": {
    operation: "create_refund";
    call_id: string;
    output: Refund;
  };
  "tool.error.returned": {
    operation: "create_refund";
    call_id: string;
    error_code: string;
    ambiguous: boolean;
    message: string;
  };
  "agent.run.failed": {
    error_code: string;
    message: string;
  };
  "agent.final_claim": {
    claim: AgentClaim;
    source: "agent" | "eigen_failure_fallback";
  };
  "run.metrics": {
    latency_ms: number;
    model_requests: number;
    tool_calls: number;
    input_tokens?: number | undefined;
    output_tokens?: number | undefined;
    token_usage_available: boolean;
  };
  "world.snapshot": { snapshot: WorldSnapshot };
  "evaluator.finding": { finding: Finding };
  "run.completed": {
    result: "pass" | "fail";
    deployment_decision: "allow" | "block";
  };
}

export type TraceEventType = keyof TracePayloadMap;

interface TraceEventBase {
  id: string;
  sequence: number;
  timestamp: string;
  correlation_id?: string | undefined;
}

export type TraceEvent = {
  [Type in TraceEventType]: TraceEventBase & {
    type: Type;
    payload: TracePayloadMap[Type];
  };
}[TraceEventType];

export interface RunResult {
  run_id: string;
  scenario: Scenario;
  agent_id: string;
  started_at: string;
  completed_at: string;
  initial_world: WorldSnapshot;
  final_world: WorldSnapshot;
  final_claim: AgentClaim;
  final_claim_source: "agent" | "eigen_failure_fallback";
  run_number?: number | undefined;
  agent_error?:
    | {
        code: string;
        message: string;
      }
    | undefined;
  metrics?: RunMetrics | undefined;
  trace: TraceEvent[];
  findings: Finding[];
  result: "pass" | "fail";
  deployment_decision: "allow" | "block";
}

export interface RunReport {
  schema_version: "1.1";
  run_id: string;
  scenario_id: string;
  scenario_name: string;
  seed: number;
  agent_id: string;
  started_at: string;
  completed_at: string;
  mandate: Mandate;
  initial_world: WorldSnapshot;
  final_world: WorldSnapshot;
  trace: TraceEvent[];
  findings: Finding[];
  result: "pass" | "fail";
  deployment_decision: "allow" | "block";
  final_claim: AgentClaim;
  final_claim_source: "agent" | "eigen_failure_fallback";
  run_number?: number | undefined;
  agent_error?:
    | {
        code: string;
        message: string;
      }
    | undefined;
  metrics?: RunMetrics | undefined;
  summary: {
    refund_count: number;
    total_refunded: number;
    critical_finding_count: number;
    findings_by_category: FindingCategoryCounts;
  };
}

export interface FindingCategoryCounts {
  financial_safety: number;
  reliability: number;
  truthfulness: number;
  calibration: number;
  trace_integrity: number;
}

export interface RunMetrics {
  latency_ms: number;
  model_requests: number;
  tool_calls: number;
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  token_usage_available: boolean;
}

export interface CriticalFindingReference {
  scenario_id: string;
  code: FindingCode;
  category: FindingCategory;
}

export interface AgentComparisonResult {
  agent_id: string;
  runs: RunReport[];
  summary: {
    passed: number;
    total: number;
    duplicate_financial_effects: number;
    safe_completion_rate: number;
    findings_by_category: FindingCategoryCounts;
    critical_findings: CriticalFindingReference[];
    decision: "pass" | "block";
  };
}

export interface ComparisonReport {
  schema_version: "1.2";
  comparison_id: string;
  created_at: string;
  scenario_directory: string;
  scenarios: Array<{
    scenario_id: string;
    scenario_name: string;
    seed: number;
    baseline_result: "pass" | "fail";
    candidate_result: "pass" | "fail";
  }>;
  baseline: AgentComparisonResult;
  candidate: AgentComparisonResult;
  critical_findings_removed: CriticalFindingReference[];
  critical_findings_added: CriticalFindingReference[];
  decision: "pass" | "block";
}

export interface ExperimentTokenSummary {
  availability: "complete" | "partial" | "unavailable";
  reported_runs: number;
  input_tokens: number;
  output_tokens: number;
  average_input_tokens?: number | undefined;
  average_output_tokens?: number | undefined;
}

export interface ExperimentTrajectoryVariationSummary {
  unique_trajectories: number;
  modal_share: number;
  trajectory_variation_rate: number;
  signatures: Array<{
    signature: string;
    count: number;
  }>;
}

export interface ExperimentMetrics {
  total_runs: number;
  passed_runs: number;
  safe_completion_rate: number;
  findings_by_category: FindingCategoryCounts;
  outcome_instability_rate: number;
  duplicate_effect_count: number;
  duplicate_effect_rate: number;
  payment_state_truth_accuracy: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  average_tool_call_count: number;
  tokens: ExperimentTokenSummary;
}

export interface ExperimentRunReference {
  scenario_id: string;
  run_number: number;
  result: "pass" | "fail";
  final_status: AgentClaim["status"];
  trace_path: string;
  trajectory_signature: string;
  critical_finding_codes: FindingCode[];
  latency_ms: number;
  tool_call_count: number;
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
}

export interface ExperimentScenarioResult {
  scenario_id: string;
  scenario_name: string;
  metrics: ExperimentMetrics;
  trajectory_variation: ExperimentTrajectoryVariationSummary;
  runs: ExperimentRunReference[];
}

export interface ExperimentAgentResult {
  agent_id: string;
  model: string;
  prompt_hash: string;
  tool_manifest_hash: string;
  metrics: ExperimentMetrics;
  trajectory_variation: ExperimentTrajectoryVariationSummary;
  scenarios: ExperimentScenarioResult[];
  critical_traces: Array<{
    scenario_id: string;
    run_number: number;
    trace_path: string;
    findings: Array<{
      code: FindingCode;
      evidence_event_ids: string[];
    }>;
  }>;
  decision: "pass" | "block";
}

export interface ExperimentReport {
  schema_version: "1.1";
  experiment_id: string;
  created_at: string;
  scenario_directory: string;
  runs_per_scenario: number;
  agents: ExperimentAgentResult[];
  comparison: {
    baseline_agent_id: string;
    candidate_agent_id: string;
    candidate_minus_baseline: Record<string, number | null>;
    scenarios: Array<{
      scenario_id: string;
      candidate_minus_baseline: Record<string, number | null>;
    }>;
  };
}

export interface RegressionRequiredInvariants {
  required_refund: {
    count: number;
    payment_id: string;
    amount: number;
    currency: Currency;
    purpose: string;
  };
  required_final_status: "completed";
  final_claim_must_match_authoritative_state: true;
}

export interface RegressionManifest {
  schema_version: "1.0";
  name: string;
  source_trace: string;
  archived_source_trace: string;
  source_trace_sha256: string;
  scenario: string;
  source_agent_profile: string;
  source_model: string;
  source_prompt_hash: string;
  source_tool_manifest_hash: string;
  deterministic_world_seed: number;
  fault_configuration: FaultSpec[];
  original_findings: string[];
  required_invariants: RegressionRequiredInvariants;
  minimum_repeated_runs: number;
  permitted_financial_safety_violations: number;
  permitted_reliability_failures: number;
  required_pass_rate: number;
}

export interface RegressionMetrics {
  total_runs: number;
  passed_runs: number;
  safe_completion_rate: number;
  recovery_success_rate: number;
  findings_by_category: FindingCategoryCounts;
  outcome_instability_rate: number;
  trajectory_variation_rate: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  average_tool_call_count: number;
  tokens: ExperimentTokenSummary;
}

export interface RegressionRunReference {
  run_number: number;
  result: "pass" | "fail";
  trace_path: string;
  finding_codes: FindingCode[];
  final_status: AgentClaim["status"];
}

export interface RegressionAgentResult {
  agent_id: string;
  model: string;
  prompt_hash: string;
  tool_manifest_hash: string;
  status: "VERIFIED" | "INTERMITTENT" | "UNCHANGED";
  original_failure_reproduced: boolean;
  metrics: RegressionMetrics;
  runs: RegressionRunReference[];
  failing_trace_paths: string[];
}

export interface RegressionReport {
  schema_version: "1.0";
  regression_id: string;
  created_at: string;
  manifest: string;
  regression_name: string;
  source_trace: string;
  original_findings: string[];
  runs_per_agent: number;
  baseline_agent_id: string;
  candidate_agent_id: string;
  agents: RegressionAgentResult[];
  candidate_status: RegressionAgentResult["status"];
}
