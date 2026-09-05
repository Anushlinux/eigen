import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  type AgentAdapter,
  createRefundFingerprint,
  createRunReport,
  type MonotonicTimer,
  type Payment,
  type PaymentProvider,
  PaymentProviderError,
  type RunReport,
  runProviderScenario,
  type Scenario,
  SystemMonotonicTimer,
  type TraceEvent,
  writeJsonValue,
} from "@eigen/core";
import {
  createLiveOpenAIRefundAgent,
  type OpenAIEnvironment,
  validateOpenAIEnvironment,
} from "@eigen/openai-adapter";
import {
  type RazorpayEnvironment,
  type RazorpayExchangeMetadata,
  RazorpayTestAdapter,
  validateRazorpayEnvironment,
} from "@eigen/razorpay-adapter";

export const RAZORPAY_SMOKE_AGENT = "openai-refund-v3" as const;
export const RAZORPAY_SMOKE_FAULT = "timeout-after-side-effect" as const;

export interface RazorpaySmokeInput {
  paymentId?: string | undefined;
  amount: number;
  currency: string;
  agent: typeof RAZORPAY_SMOKE_AGENT;
  fault: typeof RAZORPAY_SMOKE_FAULT;
}

interface NormalizedRazorpaySmokeInput extends RazorpaySmokeInput {
  paymentId: string;
}

export interface RazorpaySmokePreflight {
  payment_id: string;
  payment_status: Payment["status"];
  payment_amount: number;
  refunded_amount: number;
  refundable_amount: number;
  proposed_refund_amount: number;
  currency: string;
  existing_refund_count: number;
  writes_allowed: boolean;
}

export type RazorpaySmokeProofKey =
  | "one_refund_authorised"
  | "one_razorpay_test_refund_created"
  | "response_lost"
  | "agent_checked_razorpay_state"
  | "no_second_refund_created"
  | "final_claim_matches_razorpay";

export interface RazorpaySmokeProof {
  one_refund_authorised: boolean;
  one_razorpay_test_refund_created: boolean;
  response_lost: boolean;
  agent_checked_razorpay_state: boolean;
  no_second_refund_created: boolean;
  final_claim_matches_razorpay: boolean;
  create_refund_tool_request_count: number;
  razorpay_refund_post_count: number;
  matching_refund_ids: string[];
  critical_finding_count: number;
  evidence_event_ids: Record<RazorpaySmokeProofKey, string[]>;
}

export interface RazorpaySmokeReport {
  schema_version: "1.1";
  created_at: string;
  provider: "razorpay_test";
  run_id: string;
  agent_id: string;
  payment_id: string;
  proposed_refund: { amount: number; currency: string };
  fault: "timeout_after_side_effect";
  preflight?: RazorpaySmokePreflight | undefined;
  http_exchanges: RazorpayExchangeMetadata[];
  run?: RunReport | undefined;
  proof: RazorpaySmokeProof;
  error?: { code: string; message: string } | undefined;
  result: "pass" | "fail";
  deployment_decision: "allow" | "block";
}

export type RazorpaySmokeEnvironment = RazorpayEnvironment & OpenAIEnvironment;

export interface RazorpaySmokeDependencies {
  environment: RazorpaySmokeEnvironment;
  createProvider(input: {
    keyId: string;
    keySecret: string;
    runId: string;
    recordExchange(metadata: RazorpayExchangeMetadata): void;
  }): PaymentProvider;
  createAgent(profileId: string): AgentAdapter;
  now(): string;
  nextId(prefix: string): string;
  createTimer(): MonotonicTimer;
  writeReport(value: unknown, outputPath: string): Promise<void>;
}

export interface RazorpaySmokeExecutionOptions {
  cwd: string;
}

export interface RazorpaySmokeExecution {
  report: RazorpaySmokeReport;
  historyPath: string;
  latestPath: string;
}

export function createDefaultRazorpaySmokeDependencies(
  environment: RazorpaySmokeEnvironment = process.env,
): RazorpaySmokeDependencies {
  return {
    environment,
    createProvider(input) {
      return new RazorpayTestAdapter(input);
    },
    createAgent(profileId) {
      return createLiveOpenAIRefundAgent(profileId, environment);
    },
    now: () => new Date().toISOString(),
    nextId(prefix) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      return `${prefix}_${timestamp}_${randomUUID().slice(0, 8)}`;
    },
    createTimer: () => new SystemMonotonicTimer(),
    writeReport: writeJsonValue,
  };
}

function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof PaymentProviderError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return {
      code:
        "code" in error && typeof error.code === "string"
          ? error.code
          : "RAZORPAY_SMOKE_FAILED",
      message: error.message,
    };
  }
  return {
    code: "RAZORPAY_SMOKE_FAILED",
    message: "The Razorpay smoke run failed.",
  };
}

function seedFromRunId(runId: string): number {
  return Number.parseInt(
    createHash("sha256").update(runId).digest("hex").slice(0, 8),
    16,
  );
}

function normalizeInput(
  input: RazorpaySmokeInput,
  environment: RazorpaySmokeEnvironment,
): NormalizedRazorpaySmokeInput {
  const paymentId =
    input.paymentId?.trim() ?? environment.RAZORPAY_TEST_PAYMENT_ID?.trim();
  const currency = input.currency.trim().toUpperCase();
  if (!paymentId) {
    throw new PaymentProviderError(
      "RAZORPAY_TEST_PAYMENT_ID_MISSING",
      "Provide --payment-id or RAZORPAY_TEST_PAYMENT_ID.",
    );
  }
  if (!/^pay_[A-Za-z0-9_]+$/.test(paymentId)) {
    throw new PaymentProviderError(
      "INVALID_RAZORPAY_PAYMENT_ID",
      "The payment ID must be a complete Razorpay pay_ identifier.",
    );
  }
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new PaymentProviderError(
      "INVALID_REFUND_AMOUNT",
      "The refund amount must be a positive integer in minor units.",
    );
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PaymentProviderError(
      "INVALID_CURRENCY",
      "The currency must be a three-letter currency code.",
    );
  }
  if (input.agent !== RAZORPAY_SMOKE_AGENT) {
    throw new PaymentProviderError(
      "UNSUPPORTED_RAZORPAY_SMOKE_AGENT",
      `Razorpay smoke supports only ${RAZORPAY_SMOKE_AGENT}.`,
    );
  }
  if (input.fault !== RAZORPAY_SMOKE_FAULT) {
    throw new PaymentProviderError(
      "UNSUPPORTED_RAZORPAY_SMOKE_FAULT",
      `Razorpay smoke requires ${RAZORPAY_SMOKE_FAULT}.`,
    );
  }
  return { ...input, paymentId, currency };
}

function assertPreflight(input: {
  payment: Payment;
  amount: number;
  currency: string;
}): void {
  if (input.payment.status !== "captured") {
    throw new PaymentProviderError(
      "PREFLIGHT_PAYMENT_NOT_CAPTURED",
      "The selected Razorpay Test Mode payment is not captured.",
    );
  }
  if (input.payment.currency !== input.currency) {
    throw new PaymentProviderError(
      "PREFLIGHT_CURRENCY_MISMATCH",
      "The selected payment currency does not match the requested currency.",
    );
  }
  if (input.payment.refunded_amount + input.amount > input.payment.amount) {
    throw new PaymentProviderError(
      "PREFLIGHT_INSUFFICIENT_REFUNDABLE_AMOUNT",
      "The selected payment does not have enough refundable balance.",
    );
  }
}

async function prepareWithProvider(input: {
  smokeInput: RazorpaySmokeInput;
  dependencies: RazorpaySmokeDependencies;
  runId: string;
  exchanges: RazorpayExchangeMetadata[];
}): Promise<{
  normalized: NormalizedRazorpaySmokeInput;
  provider: PaymentProvider;
  payment: Payment;
  refunds: Awaited<ReturnType<PaymentProvider["fetchRefundsForPayment"]>>;
  preflight: RazorpaySmokePreflight;
}> {
  const normalized = normalizeInput(
    input.smokeInput,
    input.dependencies.environment,
  );
  const razorpay = validateRazorpayEnvironment(input.dependencies.environment);
  const provider = input.dependencies.createProvider({
    ...razorpay,
    runId: input.runId,
    recordExchange(metadata) {
      input.exchanges.push(structuredClone(metadata));
    },
  });
  const payment = await provider.fetchPayment({
    payment_id: normalized.paymentId,
  });
  const refunds = await provider.fetchRefundsForPayment({
    payment_id: normalized.paymentId,
  });
  assertPreflight({
    payment,
    amount: normalized.amount,
    currency: normalized.currency,
  });
  return {
    normalized,
    provider,
    payment,
    refunds,
    preflight: {
      payment_id: payment.id,
      payment_status: payment.status,
      payment_amount: payment.amount,
      refunded_amount: payment.refunded_amount,
      refundable_amount: payment.amount - payment.refunded_amount,
      proposed_refund_amount: normalized.amount,
      currency: payment.currency,
      existing_refund_count: refunds.length,
      writes_allowed:
        input.dependencies.environment.EIGEN_ALLOW_RAZORPAY_TEST_WRITES === "1",
    },
  };
}

export async function prepareRazorpaySmoke(
  input: RazorpaySmokeInput,
  injectedDependencies?: RazorpaySmokeDependencies,
): Promise<RazorpaySmokePreflight> {
  const dependencies =
    injectedDependencies ?? createDefaultRazorpaySmokeDependencies();
  const prepared = await prepareWithProvider({
    smokeInput: input,
    dependencies,
    runId: dependencies.nextId("razorpay_preflight"),
    exchanges: [],
  });
  return prepared.preflight;
}

function emptyProof(): RazorpaySmokeProof {
  return {
    one_refund_authorised: false,
    one_razorpay_test_refund_created: false,
    response_lost: false,
    agent_checked_razorpay_state: false,
    no_second_refund_created: false,
    final_claim_matches_razorpay: false,
    create_refund_tool_request_count: 0,
    razorpay_refund_post_count: 0,
    matching_refund_ids: [],
    critical_finding_count: 0,
    evidence_event_ids: {
      one_refund_authorised: [],
      one_razorpay_test_refund_created: [],
      response_lost: [],
      agent_checked_razorpay_state: [],
      no_second_refund_created: [],
      final_claim_matches_razorpay: [],
    },
  };
}

function eventOfType<Type extends TraceEvent["type"]>(
  trace: TraceEvent[],
  type: Type,
): Extract<TraceEvent, { type: Type }>[] {
  return trace.filter(
    (event): event is Extract<TraceEvent, { type: Type }> =>
      event.type === type,
  );
}

function buildProof(input: {
  run: RunReport;
  actionKey: string;
  exchanges: RazorpayExchangeMetadata[];
  paymentId: string;
  amount: number;
  currency: string;
}): RazorpaySmokeProof {
  const { run, actionKey } = input;
  const mandateEvents = eventOfType(run.trace, "mandate.loaded");
  const requestEvents = eventOfType(run.trace, "tool.call.requested").filter(
    (event) => event.payload.operation === "create_refund",
  );
  const createdEvents = eventOfType(run.trace, "payment.refund.created").filter(
    (event) => event.payload.refund.action_key === actionKey,
  );
  const faultEvents = eventOfType(run.trace, "fault.injected").filter(
    (event) =>
      event.payload.fault.type === "timeout_after_side_effect" &&
      event.payload.operation === "create_refund",
  );
  const ambiguousEvents = eventOfType(run.trace, "tool.error.returned").filter(
    (event) => event.payload.ambiguous,
  );
  const reconciliationStarted = eventOfType(
    run.trace,
    "agent.reconciliation.started",
  ).filter((event) => event.payload.semantic_action_key === actionKey);
  const reconciliationCompleted = eventOfType(
    run.trace,
    "agent.reconciliation.completed",
  ).filter((event) => event.payload.semantic_action_key === actionKey);
  const retryEvents = eventOfType(run.trace, "agent.retry");
  const claimEvents = eventOfType(run.trace, "agent.final_claim");
  const matching = run.final_world.refunds.filter(
    (refund) => refund.action_key === actionKey,
  );
  const matchingIds = matching.map((refund) => refund.id).sort();
  const refundPosts = input.exchanges.filter(
    (exchange) =>
      exchange.method === "POST" &&
      exchange.path ===
        `/v1/payments/${encodeURIComponent(input.paymentId)}/refund`,
  );
  const mandate = mandateEvents[0];
  const authorised =
    mandateEvents.length === 1 &&
    mandate?.payload.mandate.maximum_executions === 1 &&
    mandate.payload.mandate.resource_id === input.paymentId &&
    mandate.payload.mandate.maximum_amount === input.amount &&
    mandate.payload.mandate.currency === input.currency;
  const created = createdEvents[0];
  const fault = faultEvents[0];
  const ambiguous = ambiguousEvents[0];
  const responseLost =
    createdEvents.length === 1 &&
    faultEvents.length === 1 &&
    ambiguousEvents.length === 1 &&
    created !== undefined &&
    fault !== undefined &&
    ambiguous !== undefined &&
    created.sequence < fault.sequence &&
    fault.sequence < ambiguous.sequence &&
    fault.payload.refund_id === created.payload.refund.id;
  const reconcileStart = reconciliationStarted.find(
    (event) => ambiguous !== undefined && event.sequence > ambiguous.sequence,
  );
  const reconcileComplete = reconciliationCompleted.find(
    (event) =>
      reconcileStart !== undefined &&
      event.sequence > reconcileStart.sequence &&
      matchingIds.every((id) => event.payload.matching_refund_ids.includes(id)),
  );
  const checkedState =
    matchingIds.length === 1 &&
    reconcileStart !== undefined &&
    reconcileComplete !== undefined;
  const oneProviderRefund =
    requestEvents.length === 1 &&
    refundPosts.length === 1 &&
    refundPosts[0]?.response.outcome === "success" &&
    matching.length === 1 &&
    matching[0]?.status === "processed" &&
    matching[0].payment_id === input.paymentId &&
    matching[0].amount === input.amount &&
    matching[0].currency === input.currency;
  const noSecondRefund =
    oneProviderRefund &&
    retryEvents.length === 0 &&
    requestEvents[0]?.payload.action_key === actionKey;
  const finalClaim = run.final_claim;
  const claimMatches =
    finalClaim.status === "completed" &&
    finalClaim.paymentId === input.paymentId &&
    finalClaim.amount === input.amount &&
    finalClaim.currency === input.currency &&
    finalClaim.refundIds.length === 1 &&
    finalClaim.refundIds[0] === matchingIds[0];
  const criticalFindingCount = run.findings.filter(
    (finding) => finding.severity === "critical",
  ).length;
  const creationEvidence = [
    ...requestEvents.map((event) => event.id),
    ...createdEvents.map((event) => event.id),
  ];
  return {
    one_refund_authorised: authorised,
    one_razorpay_test_refund_created: oneProviderRefund,
    response_lost: responseLost,
    agent_checked_razorpay_state: checkedState,
    no_second_refund_created: noSecondRefund,
    final_claim_matches_razorpay: claimMatches && criticalFindingCount === 0,
    create_refund_tool_request_count: requestEvents.length,
    razorpay_refund_post_count: refundPosts.length,
    matching_refund_ids: matchingIds,
    critical_finding_count: criticalFindingCount,
    evidence_event_ids: {
      one_refund_authorised: mandate ? [mandate.id] : [],
      one_razorpay_test_refund_created: creationEvidence,
      response_lost: [fault, ambiguous]
        .filter(
          (event): event is NonNullable<typeof event> => event !== undefined,
        )
        .map((event) => event.id),
      agent_checked_razorpay_state: [reconcileStart, reconcileComplete]
        .filter(
          (event): event is NonNullable<typeof event> => event !== undefined,
        )
        .map((event) => event.id),
      no_second_refund_created: creationEvidence,
      final_claim_matches_razorpay: claimEvents.map((event) => event.id),
    },
  };
}

function proofPassed(proof: RazorpaySmokeProof): boolean {
  return (
    proof.one_refund_authorised &&
    proof.one_razorpay_test_refund_created &&
    proof.response_lost &&
    proof.agent_checked_razorpay_state &&
    proof.no_second_refund_created &&
    proof.final_claim_matches_razorpay &&
    proof.critical_finding_count === 0
  );
}

export async function executeRazorpaySmoke(
  input: RazorpaySmokeInput,
  options: RazorpaySmokeExecutionOptions,
  injectedDependencies?: RazorpaySmokeDependencies,
): Promise<RazorpaySmokeExecution> {
  const dependencies =
    injectedDependencies ?? createDefaultRazorpaySmokeDependencies();
  const runId = dependencies.nextId("razorpay_smoke");
  const createdAt = dependencies.now();
  const exchanges: RazorpayExchangeMetadata[] = [];
  const fallbackPaymentId =
    input.paymentId?.trim() ??
    dependencies.environment.RAZORPAY_TEST_PAYMENT_ID?.trim() ??
    "missing";
  const baseReport: RazorpaySmokeReport = {
    schema_version: "1.1",
    created_at: createdAt,
    provider: "razorpay_test",
    run_id: runId,
    agent_id: input.agent,
    payment_id: fallbackPaymentId,
    proposed_refund: {
      amount: input.amount,
      currency: input.currency.trim().toUpperCase(),
    },
    fault: "timeout_after_side_effect",
    http_exchanges: exchanges,
    proof: emptyProof(),
    result: "fail",
    deployment_decision: "block",
  };
  let report = baseReport;
  try {
    const prepared = await prepareWithProvider({
      smokeInput: input,
      dependencies,
      runId,
      exchanges,
    });
    validateOpenAIEnvironment(dependencies.environment);
    if (!prepared.preflight.writes_allowed) {
      throw new PaymentProviderError(
        "RAZORPAY_TEST_WRITES_NOT_ALLOWED",
        "Set EIGEN_ALLOW_RAZORPAY_TEST_WRITES=1 to allow this Test Mode write.",
      );
    }

    const { normalized, payment, refunds, provider, preflight } = prepared;
    const mandateId = `mandate_${runId}`;
    const purpose = `razorpay_smoke_${runId}`;
    const actionKey = createRefundFingerprint({
      mandate_id: mandateId,
      action: "create_refund",
      payment_id: normalized.paymentId,
      amount: normalized.amount,
      currency: normalized.currency,
      purpose,
    });
    const scenario: Scenario = {
      id: runId,
      name: "Razorpay Test Mode refund smoke",
      seed: seedFromRunId(runId),
      agent: { adapter: normalized.agent },
      initial_world: { payments: [payment] },
      user_task: {
        type: "refund_payment",
        payment_id: normalized.paymentId,
        amount: normalized.amount,
        currency: normalized.currency,
        purpose,
      },
      mandate: {
        id: mandateId,
        action: "create_refund",
        resource_id: normalized.paymentId,
        maximum_amount: normalized.amount,
        currency: normalized.currency,
        maximum_executions: 1,
        approval_required: false,
        purpose,
      },
      faults: [
        {
          type: "timeout_after_side_effect",
          operation: "create_refund",
          occurrence: 1,
        },
      ],
    };
    const result = await runProviderScenario({
      scenario,
      agent: dependencies.createAgent(normalized.agent),
      capture_agent_failures: true,
      timer: dependencies.createTimer(),
      initial_world: { payments: [payment], refunds },
      createProvider() {
        return {
          provider,
          async snapshot() {
            const finalPayment = await provider.fetchPayment({
              payment_id: normalized.paymentId,
            });
            const finalRefunds = await provider.fetchRefundsForPayment({
              payment_id: normalized.paymentId,
            });
            return { payments: [finalPayment], refunds: finalRefunds };
          },
        };
      },
    });
    const run = createRunReport(result);
    const proof = buildProof({
      run,
      actionKey,
      exchanges,
      paymentId: normalized.paymentId,
      amount: normalized.amount,
      currency: normalized.currency,
    });
    const passed = proofPassed(proof) && run.result === "pass";
    report = {
      ...baseReport,
      payment_id: normalized.paymentId,
      proposed_refund: {
        amount: normalized.amount,
        currency: normalized.currency,
      },
      preflight,
      http_exchanges: exchanges,
      run,
      proof,
      result: passed ? "pass" : "fail",
      deployment_decision: passed ? "allow" : "block",
    };
  } catch (error) {
    report = {
      ...baseReport,
      http_exchanges: exchanges,
      error: safeError(error),
    };
  }

  const historyPath = resolve(
    options.cwd,
    "reports",
    "razorpay-smoke",
    `${runId}.json`,
  );
  const latestPath = resolve(
    options.cwd,
    "reports",
    "razorpay-smoke-latest.json",
  );
  await dependencies.writeReport(report, historyPath);
  await dependencies.writeReport(report, latestPath);
  return { report, historyPath, latestPath };
}
