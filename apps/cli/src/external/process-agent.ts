import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { AgentAdapter, AgentClaim, AgentRunInput } from "@eigen/core";
import { openAIRefundClaimSchema } from "@eigen/openai-adapter";
import { z } from "zod";
import type { ExternalApplication } from "./application.js";
import { startPaymentServer } from "./payment-server.js";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const eventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("configuration"),
      model: text,
      prompt_hash: text.regex(/^[a-f0-9]{64}$/),
      tool_manifest_hash: text.regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ type: z.literal("model_started"), turn: count }).strict(),
  z
    .object({
      type: z.literal("model_finished"),
      turn: count,
      outcome: z.enum(["success", "error"]),
      latency_ms: z.number().nonnegative(),
      input_tokens: count.optional(),
      output_tokens: count.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_selected"),
      name: text,
      call_id: text,
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      name: text,
      call_id: text,
      result: z.unknown(),
    })
    .strict(),
  z.object({ type: z.literal("message"), message: text }).strict(),
  z
    .object({ type: z.literal("final"), claim: openAIRefundClaimSchema })
    .strict(),
  z.object({ type: z.literal("error"), code: text }).strict(),
]);

export interface ExternalAgentOptions {
  application: ExternalApplication;
  apiKey: string;
  model: string;
  timeoutMs: number;
  // Test injection only. The CLI never forwards a custom model endpoint.
  modelBaseUrl?: string;
}

class ExternalAgentError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class ExternalProcessAgent implements AgentAdapter {
  readonly id: string;
  constructor(private readonly options: ExternalAgentOptions) {
    this.id = options.application.id;
  }

  async run(input: AgentRunInput): Promise<AgentClaim> {
    const token = randomUUID();
    const paymentServer = await startPaymentServer(input, token);
    try {
      return await this.runProcess(input, paymentServer.baseUrl, token);
    } finally {
      await paymentServer.close();
    }
  }

  private runProcess(
    input: AgentRunInput,
    paymentUrl: string,
    token: string,
  ): Promise<AgentClaim> {
    const { application, apiKey, model, timeoutMs, modelBaseUrl } =
      this.options;
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        process.execPath,
        [resolve(application.directory, application.entrypoint)],
        {
          cwd: application.directory,
          shell: false,
          env: {
            OPENAI_API_KEY: apiKey,
            OPENAI_MODEL: model,
            EIGEN_PAYMENT_BASE_URL: paymentUrl,
            EIGEN_PAYMENT_TOKEN: token,
            ...(modelBaseUrl ? { OPENAI_BASE_URL: modelBaseUrl } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let failure: string | undefined;
      let buffer = "";
      let bytes = 0;
      let claim: AgentClaim | undefined;
      let configured = false;
      let completedRequests = 0;
      const requests = new Map<number, string>();
      const calls = new Map<string, string>();
      const fail = (code: string) => {
        failure ??= code;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => fail("EXTERNAL_AGENT_TIMEOUT"), timeoutMs);
      child.once("error", () => fail("EXTERNAL_AGENT_START_FAILED"));
      child.stdin.on("error", () => fail("EXTERNAL_AGENT_INPUT_FAILED"));
      // Untrusted application stderr is not an evidence channel; never echo it.
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1_000_000) fail("EXTERNAL_AGENT_OUTPUT_LIMIT");
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1_000_000) {
          fail("EXTERNAL_AGENT_OUTPUT_LIMIT");
          return;
        }
        buffer += chunk;
        while (buffer.includes("\n") && !failure) {
          const end = buffer.indexOf("\n");
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const event = eventSchema.parse(
              JSON.parse(
                line
                  .split(apiKey)
                  .join("[REDACTED]")
                  .split(token)
                  .join("[REDACTED]"),
              ),
            );
            if (claim) throw new Error("Event after final claim");
            if (event.type !== "configuration" && !configured)
              throw new Error("Missing configuration");
            switch (event.type) {
              case "configuration":
                if (configured || event.model !== model)
                  throw new Error("Invalid configuration");
                configured = true;
                input.instrumentation.configurationLoaded({
                  model,
                  prompt_profile: this.id,
                  prompt_hash: event.prompt_hash,
                  tool_manifest_hash: event.tool_manifest_hash,
                });
                break;
              case "model_started":
                if (requests.has(event.turn))
                  throw new Error("Duplicate model turn");
                requests.set(
                  event.turn,
                  input.instrumentation.modelRequestStarted({
                    model,
                    turn: event.turn,
                  }),
                );
                break;
              case "model_finished": {
                const requestId = requests.get(event.turn);
                if (!requestId) throw new Error("Unmatched model result");
                requests.delete(event.turn);
                completedRequests += Number(event.outcome === "success");
                input.instrumentation.modelRequestFinished({
                  model,
                  turn: event.turn,
                  request_id: requestId,
                  outcome: event.outcome,
                  latency_ms: event.latency_ms,
                  ...(event.input_tokens === undefined
                    ? {}
                    : { input_tokens: event.input_tokens }),
                  ...(event.output_tokens === undefined
                    ? {}
                    : { output_tokens: event.output_tokens }),
                  ...(event.outcome === "error"
                    ? { error_code: "MODEL_REQUEST_FAILED" }
                    : {}),
                });
                break;
              }
              case "tool_selected":
                if (calls.has(event.call_id))
                  throw new Error("Duplicate tool call");
                calls.set(event.call_id, event.name);
                input.instrumentation.modelToolSelected({
                  tool_name: event.name,
                  tool_call_id: event.call_id,
                  arguments: event.arguments,
                });
                break;
              case "tool_result":
                if (calls.get(event.call_id) !== event.name)
                  throw new Error("Unmatched tool result");
                calls.delete(event.call_id);
                input.instrumentation.modelToolResult({
                  tool_name: event.name,
                  tool_call_id: event.call_id,
                  result: event.result,
                });
                break;
              case "message":
                input.emitMessage(event.message);
                break;
              case "final":
                claim = event.claim;
                break;
              case "error":
                fail("EXTERNAL_APPLICATION_FAILED");
                break;
            }
          } catch {
            fail("EXTERNAL_AGENT_PROTOCOL_ERROR");
          }
        }
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (
          failure ||
          code !== 0 ||
          !claim ||
          buffer.trim() ||
          !configured ||
          completedRequests === 0 ||
          requests.size ||
          calls.size
        ) {
          reject(
            new ExternalAgentError(failure ?? "EXTERNAL_AGENT_INCOMPLETE"),
          );
        } else resolveResult(claim);
      });
      child.stdin.end(
        `${JSON.stringify({
          caseId: input.task.purpose,
          paymentId: input.task.payment_id,
          amount: input.task.amount,
          currency: input.task.currency,
          authority: {
            paymentId: input.mandate.resource_id,
            maximumAmount: input.mandate.maximum_amount,
            currency: input.mandate.currency,
            maximumExecutions: input.mandate.maximum_executions,
            approvalRequired: input.mandate.approval_required,
          },
        })}\n`,
      );
    });
  }
}
