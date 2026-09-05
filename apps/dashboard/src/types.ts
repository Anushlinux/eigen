export interface TraceEvent {
  id: string;
  sequence: number;
  timestamp: string;
  type: string;
  correlation_id?: string;
  payload: Record<string, unknown>;
}

export interface Finding {
  code: string;
  category: string;
  severity: "info" | "warning" | "critical";
  title: string;
  explanation: string;
  evidence_event_ids: string[];
}

export interface Refund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
  action_key: string;
}

export interface RunReport {
  run_id: string;
  scenario_id: string;
  scenario_name: string;
  agent_id: string;
  started_at: string;
  completed_at: string;
  trace: TraceEvent[];
  findings: Finding[];
  initial_world: { payments: unknown[]; refunds: Refund[] };
  final_world: { payments: unknown[]; refunds: Refund[] };
  final_claim: {
    status: "completed" | "pending" | "failed" | "unknown";
    paymentId: string;
    refundIds: string[];
    amount: number;
    currency: string;
    message: string;
  };
  result: "pass" | "fail";
  deployment_decision: "allow" | "block";
}

export interface ComparisonAgentResult {
  agent_id: string;
  runs: RunReport[];
  summary: {
    passed: number;
    total: number;
    duplicate_financial_effects: number;
    safe_completion_rate: number;
    findings_by_category: Record<string, number>;
    critical_findings: Array<{
      scenario_id: string;
      code: string;
      category: string;
    }>;
    decision: "pass" | "block";
  };
}

export interface ComparisonReport {
  schema_version: "1.1" | "1.2";
  comparison_id?: string;
  created_at?: string;
  scenario_directory: string;
  scenarios: Array<{
    scenario_id: string;
    scenario_name: string;
    seed: number;
    baseline_result: "pass" | "fail";
    candidate_result: "pass" | "fail";
  }>;
  baseline: ComparisonAgentResult;
  candidate: ComparisonAgentResult;
  critical_findings_removed: Array<{
    scenario_id: string;
    code: string;
    category: string;
  }>;
  critical_findings_added: Array<{
    scenario_id: string;
    code: string;
    category: string;
  }>;
  decision: "pass" | "block";
}

export type SmokeProofKey =
  | "one_refund_authorised"
  | "one_razorpay_test_refund_created"
  | "response_lost"
  | "agent_checked_razorpay_state"
  | "no_second_refund_created"
  | "final_claim_matches_razorpay";

export interface SmokeReport {
  schema_version: "1.0" | "1.1";
  created_at: string;
  provider: "razorpay_test";
  run_id: string;
  agent_id: string;
  payment_id: string;
  proposed_refund: { amount: number; currency: string };
  fault: "timeout_after_side_effect";
  preflight?: SmokePreflight;
  http_exchanges: Array<{
    method: "GET" | "POST";
    path: string;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
  }>;
  run?: RunReport;
  proof?: Record<SmokeProofKey, boolean> & {
    create_refund_tool_request_count: number;
    razorpay_refund_post_count: number;
    matching_refund_ids: string[];
    critical_finding_count: number;
    evidence_event_ids: Record<SmokeProofKey, string[]>;
  };
  error?: { code: string; message: string };
  result: "pass" | "fail";
  deployment_decision: "allow" | "block";
}

export interface SmokePreflight {
  payment_id: string;
  payment_status: string;
  payment_amount: number;
  refunded_amount: number;
  refundable_amount: number;
  proposed_refund_amount: number;
  currency: string;
  existing_refund_count: number;
  writes_allowed: boolean;
}

export interface ReportSummary {
  kind: "comparison" | "smoke";
  id: string;
  created_at: string | null;
  decision: "allow" | "block";
  subject: string;
  schema_version: string;
}

export interface DashboardStatus {
  razorpay_test_credentials_configured: boolean;
  live_credentials_rejected: boolean;
  openai_configured: boolean;
  writes_enabled: boolean;
}

export interface SmokeInput {
  paymentId: string;
  amount: number;
  currency: string;
  agent: "openai-refund-v3";
  fault: "timeout-after-side-effect";
}
