import type {
  AgentAdapter,
  AgentCreateRefundInput,
  AgentFetchRefundsInput,
  AgentPaymentTools,
} from "../agents/index.js";
import {
  createRefundFingerprint,
  DeterministicClock,
  DeterministicIdGenerator,
  type Refund,
  type RunResult,
  type Scenario,
  TraceRecorder,
  type WorldSnapshot,
} from "../domain/index.js";
import { runFinancialEvaluators } from "../evaluators/index.js";
import {
  AmbiguousResultError,
  PaymentWorld,
  PaymentWorldError,
} from "../payment-world/index.js";

export interface RunScenarioInput {
  scenario: Scenario;
  agent: AgentAdapter;
}

export async function runScenario(input: RunScenarioInput): Promise<RunResult> {
  const { scenario, agent } = input;
  const clock = new DeterministicClock(scenario.seed);
  const ids = new DeterministicIdGenerator(scenario.seed);
  const trace = new TraceRecorder(clock, ids);
  const runId = ids.next("run");
  const startedAt = clock.now();
  const initialWorld: WorldSnapshot = structuredClone({
    payments: scenario.initial_world.payments,
    refunds: [],
  });

  trace.append("scenario.started", {
    scenario_id: scenario.id,
    seed: scenario.seed,
    agent_id: agent.id,
  });
  trace.append("user.task.received", { task: scenario.user_task });
  trace.append("mandate.loaded", { mandate: scenario.mandate });

  const world = new PaymentWorld({
    payments: scenario.initial_world.payments,
    faults: scenario.faults,
    ids,
    clock,
    trace,
  });
  const lastAmbiguousCall = new Map<string, string>();

  const tools: AgentPaymentTools = {
    async createRefund(agentInput: AgentCreateRefundInput): Promise<Refund> {
      const callId = ids.next("call");
      const fingerprint = createRefundFingerprint({
        mandate_id: scenario.mandate.id,
        action: "create_refund",
        payment_id: agentInput.payment_id,
        amount: agentInput.amount,
        currency: agentInput.currency,
        purpose: agentInput.purpose,
      });
      const previousCallId = lastAmbiguousCall.get(fingerprint);
      if (previousCallId) {
        trace.append(
          "agent.retry",
          {
            operation: "create_refund",
            previous_call_id: previousCallId,
            semantic_fingerprint: fingerprint,
            action_key: agentInput.action_key,
          },
          callId,
        );
      }

      trace.append(
        "tool.call.requested",
        {
          operation: "create_refund",
          call_id: callId,
          request_id: agentInput.request_id,
          action_key: agentInput.action_key,
          input: {
            payment_id: agentInput.payment_id,
            amount: agentInput.amount,
            currency: agentInput.currency,
            purpose: agentInput.purpose,
          },
          semantic_fingerprint: fingerprint,
        },
        callId,
      );
      trace.append(
        "tool.call.accepted",
        { operation: "create_refund", call_id: callId },
        callId,
      );

      try {
        const refund = await world.createRefund({
          ...agentInput,
          call_id: callId,
          mandate: scenario.mandate,
        });
        trace.append(
          "tool.response.returned",
          { operation: "create_refund", call_id: callId, output: refund },
          callId,
        );
        return refund;
      } catch (error) {
        const knownError =
          error instanceof AmbiguousResultError ||
          error instanceof PaymentWorldError;
        const errorCode = knownError ? error.code : "UNKNOWN_TOOL_ERROR";
        const message =
          error instanceof Error ? error.message : "Unknown payment tool error";
        const ambiguous = error instanceof AmbiguousResultError;
        trace.append(
          "tool.error.returned",
          {
            operation: "create_refund",
            call_id: callId,
            error_code: errorCode,
            ambiguous,
            message,
          },
          callId,
        );
        if (ambiguous) lastAmbiguousCall.set(fingerprint, callId);
        throw error;
      }
    },
    async fetchRefundsForPayment(
      agentInput: AgentFetchRefundsInput,
    ): Promise<Refund[]> {
      const reconciliationId = ids.next("reconciliation");
      trace.append(
        "agent.reconciliation.started",
        {
          payment_id: agentInput.payment_id,
          semantic_action_key: agentInput.semantic_action_key,
        },
        reconciliationId,
      );
      const refunds = await world.fetchRefundsForPayment({
        payment_id: agentInput.payment_id,
      });
      trace.append(
        "agent.reconciliation.completed",
        {
          payment_id: agentInput.payment_id,
          semantic_action_key: agentInput.semantic_action_key,
          matching_refund_ids: refunds
            .filter(
              (refund) =>
                refund.semantic_fingerprint === agentInput.semantic_action_key,
            )
            .map((refund) => refund.id),
        },
        reconciliationId,
      );
      return refunds;
    },
  };

  const finalClaim = await agent.run({
    task: scenario.user_task,
    mandate: scenario.mandate,
    tools,
    emitMessage(message) {
      trace.append("agent.message", { message });
    },
  });
  trace.append("agent.final_claim", { claim: finalClaim });

  const finalWorld = world.snapshot();
  trace.append("world.snapshot", { snapshot: finalWorld });
  const findings = runFinancialEvaluators({
    mandate: scenario.mandate,
    task: scenario.user_task,
    trace: trace.events(),
    final_world: finalWorld,
    final_claim: finalClaim,
  });
  for (const finding of findings) {
    trace.append("evaluator.finding", { finding });
  }

  const hasCriticalFinding = findings.some(
    (finding) => finding.severity === "critical",
  );
  const result = hasCriticalFinding ? "fail" : "pass";
  const deploymentDecision = hasCriticalFinding ? "block" : "allow";
  const completedEvent = trace.append("run.completed", {
    result,
    deployment_decision: deploymentDecision,
  });

  return {
    run_id: runId,
    scenario,
    agent_id: agent.id,
    started_at: startedAt,
    completed_at: completedEvent.timestamp,
    initial_world: initialWorld,
    final_world: finalWorld,
    final_claim: finalClaim,
    trace: trace.events(),
    findings,
    result,
    deployment_decision: deploymentDecision,
  };
}
