import type {
  AgentAdapter,
  AgentCreateRefundInput,
  AgentFetchRefundsInput,
  AgentPaymentTools,
} from "../agents/index.js";
import {
  type Clock,
  createRefundFingerprint,
  DeterministicClock,
  DeterministicIdGenerator,
  type MonotonicTimer,
  type Payment,
  type Refund,
  type RunResult,
  type Scenario,
  TraceRecorder,
  type WorldSnapshot,
} from "../domain/index.js";
import { runFinancialEvaluators } from "../evaluators/index.js";
import {
  AmbiguousResultError,
  FaultInjectingPaymentProvider,
  type PaymentProvider,
  PaymentProviderError,
  PaymentWorld,
} from "../payment-world/index.js";

export interface RunScenarioInput {
  scenario: Scenario;
  agent: AgentAdapter;
  run_number?: number | undefined;
  capture_agent_failures?: boolean | undefined;
  timer?: MonotonicTimer | undefined;
}

export interface ProviderRunContext {
  clock: Clock;
  ids: DeterministicIdGenerator;
}

export interface ProviderRunResource {
  provider: PaymentProvider;
  snapshot(): WorldSnapshot | Promise<WorldSnapshot>;
}

export interface RunProviderScenarioInput extends RunScenarioInput {
  initial_world: WorldSnapshot;
  createProvider(context: ProviderRunContext): ProviderRunResource;
}

export async function runScenario(input: RunScenarioInput): Promise<RunResult> {
  return runProviderScenario({
    ...input,
    initial_world: {
      payments: input.scenario.initial_world.payments,
      refunds: [],
    },
    createProvider({ clock, ids }) {
      const world = new PaymentWorld({
        payments: input.scenario.initial_world.payments,
        ids,
        clock,
      });
      return { provider: world, snapshot: () => world.snapshot() };
    },
  });
}

export async function runProviderScenario(
  input: RunProviderScenarioInput,
): Promise<RunResult> {
  const { scenario, agent } = input;
  const runStarted = input.timer?.now();
  const clock = new DeterministicClock(scenario.seed);
  const ids = new DeterministicIdGenerator(scenario.seed);
  const trace = new TraceRecorder(clock, ids);
  const runId = ids.next("run");
  const startedAt = clock.now();
  const initialWorld = structuredClone(input.initial_world);

  trace.append("scenario.started", {
    scenario_id: scenario.id,
    seed: scenario.seed,
    agent_id: agent.id,
    ...(input.run_number === undefined ? {} : { run_number: input.run_number }),
  });
  trace.append("user.task.received", { task: scenario.user_task });
  trace.append("mandate.loaded", { mandate: scenario.mandate });

  const providerResource = input.createProvider({ clock, ids });
  const world = new FaultInjectingPaymentProvider({
    provider: providerResource.provider,
    faults: scenario.faults,
    trace,
    initialWorld,
  });
  const lastAmbiguousCall = new Map<string, string>();
  let modelRequests = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let tokenUsageAvailable = false;

  const tools: AgentPaymentTools = {
    async fetchPayment(agentInput): Promise<Payment> {
      return world.fetchPayment({ payment_id: agentInput.payment_id });
    },
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
          error instanceof PaymentProviderError;
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

  const instrumentation = {
    configurationLoaded(configuration: {
      model: string;
      prompt_profile: string;
      prompt_hash: string;
      tool_manifest_hash: string;
    }) {
      trace.append("agent.configuration.loaded", configuration);
    },
    modelRequestStarted(request: { model: string; turn: number }): string {
      modelRequests += 1;
      const requestId = ids.next("model_request");
      trace.append(
        "model.request.started",
        { request_id: requestId, ...request },
        requestId,
      );
      return requestId;
    },
    modelRequestFinished(request: {
      request_id: string;
      model: string;
      turn: number;
      outcome: "success" | "error";
      latency_ms: number;
      input_tokens?: number | undefined;
      output_tokens?: number | undefined;
      error_code?: string | undefined;
    }) {
      if (
        request.input_tokens !== undefined ||
        request.output_tokens !== undefined
      ) {
        tokenUsageAvailable = true;
        inputTokens += request.input_tokens ?? 0;
        outputTokens += request.output_tokens ?? 0;
      }
      trace.append("model.request.finished", request, request.request_id);
    },
    modelToolSelected(selection: {
      tool_name: string;
      tool_call_id: string;
      arguments: Record<string, unknown>;
    }) {
      toolCalls += 1;
      trace.append("model.tool.selected", selection, selection.tool_call_id);
    },
    modelToolResult(result: {
      tool_name: string;
      tool_call_id: string;
      result: unknown;
    }) {
      trace.append("model.tool.result", result, result.tool_call_id);
    },
  };

  let finalClaim: RunResult["final_claim"];
  let finalClaimSource: RunResult["final_claim_source"] = "agent";
  let agentError: RunResult["agent_error"];
  try {
    finalClaim = await agent.run({
      task: scenario.user_task,
      mandate: scenario.mandate,
      tools,
      instrumentation,
      emitMessage(message) {
        trace.append("agent.message", { message });
      },
    });
  } catch (error) {
    if (!input.capture_agent_failures) throw error;
    const candidateCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "AGENT_RUN_FAILED";
    agentError = {
      code: candidateCode,
      message: "Agent execution ended without a valid final claim.",
    };
    trace.append("agent.run.failed", {
      error_code: agentError.code,
      message: agentError.message,
    });
    finalClaimSource = "eigen_failure_fallback";
    finalClaim = {
      status: "unknown",
      paymentId: scenario.user_task.payment_id,
      refundIds: [],
      amount: scenario.user_task.amount,
      currency: scenario.user_task.currency,
      message: "The agent did not produce a valid final claim.",
    };
  }
  trace.append("agent.final_claim", {
    claim: finalClaim,
    source: finalClaimSource,
  });

  const finalWorld = structuredClone(await providerResource.snapshot());
  trace.append("world.snapshot", { snapshot: finalWorld });
  const findings = runFinancialEvaluators({
    mandate: scenario.mandate,
    task: scenario.user_task,
    trace: trace.events(),
    final_world: finalWorld,
    final_claim: finalClaim,
    initial_world: initialWorld,
  });
  for (const finding of findings) {
    trace.append("evaluator.finding", { finding });
  }

  let metrics: RunResult["metrics"];
  if (input.timer && runStarted !== undefined) {
    metrics = {
      latency_ms: Math.max(0, input.timer.now() - runStarted),
      model_requests: modelRequests,
      tool_calls: toolCalls,
      ...(tokenUsageAvailable
        ? { input_tokens: inputTokens, output_tokens: outputTokens }
        : {}),
      token_usage_available: tokenUsageAvailable,
    };
    trace.append("run.metrics", metrics);
  }

  const hasCriticalFinding = findings.some(
    (finding) => finding.severity === "critical",
  );
  const runFailed = hasCriticalFinding || agentError !== undefined;
  const result = runFailed ? "fail" : "pass";
  const deploymentDecision = runFailed ? "block" : "allow";
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
    final_claim_source: finalClaimSource,
    ...(input.run_number === undefined ? {} : { run_number: input.run_number }),
    ...(agentError === undefined ? {} : { agent_error: agentError }),
    ...(metrics === undefined ? {} : { metrics }),
    trace: trace.events(),
    findings,
    result,
    deployment_decision: deploymentDecision,
  };
}
