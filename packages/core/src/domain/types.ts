export type Currency = string;

export interface Payment {
  id: string;
  amount: number;
  currency: Currency;
  status: "captured";
  refunded_amount: number;
}

export interface Refund {
  id: string;
  payment_id: string;
  amount: number;
  currency: Currency;
  status: "processed";
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
  type: "refund_initiated";
  payment_id: string;
  amount: number;
  currency: Currency;
  claimed_refund_count: number;
  status: "initiated" | "processed";
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
    adapter: "flawed-refund" | "safe-refund";
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
  | "TRACE_INCOMPLETE";

export interface Finding {
  code: FindingCode;
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
  };
  "user.task.received": { task: UserTask };
  "mandate.loaded": { mandate: Mandate };
  "agent.message": { message: string };
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
  "agent.final_claim": { claim: AgentClaim };
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
  trace: TraceEvent[];
  findings: Finding[];
  result: "pass" | "fail";
  deployment_decision: "allow" | "block";
}

export interface RunReport {
  schema_version: "1.0";
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
  summary: {
    refund_count: number;
    total_refunded: number;
    critical_finding_count: number;
  };
}

export interface CriticalFindingReference {
  scenario_id: string;
  code: FindingCode;
}

export interface AgentComparisonResult {
  agent_id: string;
  runs: RunReport[];
  summary: {
    passed: number;
    total: number;
    duplicate_financial_effects: number;
    safe_completion_rate: number;
    critical_findings: CriticalFindingReference[];
    decision: "pass" | "block";
  };
}

export interface ComparisonReport {
  schema_version: "1.0";
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
