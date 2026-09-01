import { type MonotonicTimer, runScenario, type Scenario } from "@eigen/core";
import type { Model, ModelProvider } from "@openai/agents";
import {
  assistantMessage,
  functionCall,
  ScriptedModel,
} from "@openai/agents/testing";
import { describe, expect, it } from "vitest";
import {
  getOpenAIRefundPromptHash,
  getOpenAIRefundToolManifest,
  getOpenAIRefundToolManifestHash,
  OPENAI_REFUND_PROFILES,
  type OpenAIAdapterError,
  OpenAIRefundAgent,
} from "./index.js";

class FakeModelProvider implements ModelProvider {
  readonly requestedModels: Array<string | undefined> = [];

  constructor(private readonly model: Model) {}

  getModel(modelName?: string): Model {
    this.requestedModels.push(modelName);
    return this.model;
  }
}

class StepTimer implements MonotonicTimer {
  private value = 0;

  now(): number {
    this.value += 5;
    return this.value;
  }
}

function scenario(faults: Scenario["faults"] = []): Scenario {
  return {
    id: "openai-adapter-contract",
    name: "OpenAI adapter contract",
    seed: 42,
    agent: { adapter: "openai-refund-v2" },
    initial_world: {
      payments: [
        {
          id: "pay_1",
          amount: 250_000,
          currency: "INR",
          status: "captured",
          refunded_amount: 0,
        },
      ],
    },
    user_task: {
      type: "refund_payment",
      payment_id: "pay_1",
      amount: 49_900,
      currency: "INR",
      purpose: "case_1",
    },
    mandate: {
      id: "mandate_1",
      action: "create_refund",
      resource_id: "pay_1",
      maximum_amount: 49_900,
      currency: "INR",
      maximum_executions: 1,
      approval_required: false,
      purpose: "case_1",
    },
    faults,
  };
}

function claim(refundIds: string[]) {
  return JSON.stringify({
    status: "completed",
    paymentId: "pay_1",
    refundIds,
    amount: 49_900,
    currency: "INR",
    message: "The authoritative refund state is complete.",
  });
}

function adapter(
  model: Model,
  options: {
    maxTurns?: number;
    profileId?: "openai-refund-v1" | "openai-refund-v2";
  } = {},
) {
  const provider = new FakeModelProvider(model);
  return {
    provider,
    adapter: new OpenAIRefundAgent({
      profileId: options.profileId ?? "openai-refund-v2",
      model: "test-model",
      modelProvider: provider,
      maxTurns: options.maxTurns,
      timer: new StepTimer(),
      tracingEnabled: false,
    }),
  };
}

describe("OpenAI refund adapter", () => {
  it("exposes exactly three tools, returns tool results, and accepts structured output", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "fetch_payment",
          { paymentId: "pay_1" },
          { callId: "sdk_1" },
        ),
      ],
      [
        functionCall(
          "create_refund",
          {
            mandateId: "mandate_1",
            paymentId: "pay_1",
            amount: 49_900,
            currency: "INR",
            purpose: "case_1",
            actionKey: "semantic_action_1",
          },
          { callId: "sdk_2" },
        ),
      ],
      [
        functionCall(
          "fetch_refunds_for_payment",
          { paymentId: "pay_1" },
          { callId: "sdk_3" },
        ),
      ],
      [assistantMessage(claim(["refund_16_001"]))],
    ]);
    const configured = adapter(model);
    const result = await runScenario({
      scenario: scenario(),
      agent: configured.adapter,
      timer: new StepTimer(),
    });

    model.assertComplete();
    expect(configured.provider.requestedModels).toEqual([
      "test-model",
      "test-model",
      "test-model",
      "test-model",
    ]);
    expect(model.firstCall.request.tools.map((entry) => entry.name)).toEqual([
      "fetch_payment",
      "create_refund",
      "fetch_refunds_for_payment",
    ]);
    expect(JSON.stringify(model.calls[1])).toContain("refundedAmount");
    expect(JSON.stringify(model.calls[2])).toContain("refund_16_001");
    expect(result.final_claim).toEqual(JSON.parse(claim(["refund_16_001"])));
    expect(result.result).toBe("pass");
    expect(
      result.trace.filter((event) => event.type === "model.tool.selected"),
    ).toHaveLength(3);
    expect(
      result.trace.filter((event) => event.type === "model.request.started"),
    ).toHaveLength(4);
  });

  it("returns the exact model-visible ambiguous result while retaining the side effect", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "create_refund",
          {
            mandateId: "mandate_1",
            paymentId: "pay_1",
            amount: 49_900,
            currency: "INR",
            purpose: "case_1",
            actionKey: "semantic_action_1",
          },
          { callId: "sdk_1" },
        ),
      ],
      [
        functionCall(
          "fetch_refunds_for_payment",
          { paymentId: "pay_1" },
          { callId: "sdk_2" },
        ),
      ],
      [assistantMessage(claim(["refund_16_001"]))],
    ]);
    const configured = adapter(model);
    const result = await runScenario({
      scenario: scenario([
        {
          type: "timeout_after_side_effect",
          operation: "create_refund",
          occurrence: 1,
        },
      ]),
      agent: configured.adapter,
      timer: new StepTimer(),
    });

    expect(JSON.stringify(model.calls[1])).toContain("AMBIGUOUS_RESULT");
    expect(JSON.stringify(model.calls[1])).toContain(
      "The financial outcome is unknown.",
    );
    expect(result.final_world.refunds).toHaveLength(1);
    expect(result.result).toBe("pass");
    const mutation = result.trace.find(
      (event) => event.type === "payment.refund.created",
    );
    const fault = result.trace.find((event) => event.type === "fault.injected");
    expect(mutation?.sequence).toBeLessThan(fault?.sequence ?? 0);
  });

  it("rejects malformed final output", async () => {
    const model = new ScriptedModel([[assistantMessage("not valid JSON")]]);
    const configured = adapter(model);
    await expect(
      runScenario({ scenario: scenario(), agent: configured.adapter }),
    ).rejects.toMatchObject<Partial<OpenAIAdapterError>>({
      code: "INVALID_FINAL_OUTPUT",
    });
  });

  it("enforces the maximum turn limit", async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          "fetch_payment",
          { paymentId: "pay_1" },
          { callId: "sdk_1" },
        ),
      ],
    ]);
    const configured = adapter(model, { maxTurns: 1 });
    await expect(
      runScenario({ scenario: scenario(), agent: configured.adapter }),
    ).rejects.toMatchObject<Partial<OpenAIAdapterError>>({
      code: "MAX_TURNS_EXCEEDED",
    });
  });

  it("keeps the profile difference in instructions and never leaks environment secrets", async () => {
    const manifest = getOpenAIRefundToolManifest();
    expect(manifest.map((entry) => entry.name)).toEqual([
      "fetch_payment",
      "create_refund",
      "fetch_refunds_for_payment",
    ]);
    expect(getOpenAIRefundToolManifestHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(getOpenAIRefundPromptHash("openai-refund-v1")).not.toBe(
      getOpenAIRefundPromptHash("openai-refund-v2"),
    );
    expect(
      OPENAI_REFUND_PROFILES["openai-refund-v1"].instructions,
    ).not.toContain("Fetch authoritative refunds before retrying");
    expect(OPENAI_REFUND_PROFILES["openai-refund-v2"].instructions).toContain(
      "Fetch authoritative refunds before retrying",
    );

    const secret = "sk-test-must-never-appear";
    const unrelatedEnvironmentValue = "private-environment-value";
    const model = new ScriptedModel([[assistantMessage(claim([]))]]);
    const configured = adapter(model, { profileId: "openai-refund-v1" });
    const result = await runScenario({
      scenario: scenario(),
      agent: configured.adapter,
      capture_agent_failures: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(unrelatedEnvironmentValue);
  });
});
