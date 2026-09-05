export type ApplicationEvent = { type: string; [key: string]: unknown };
export type Emit = (event: ApplicationEvent) => void;
export const MODEL_TIMEOUT_MS = 60_000;

export interface ModelResponse {
  output: Array<Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
  status: string;
}

export interface AgentModel {
  readonly name: string;
  respond(body: Record<string, unknown>): Promise<ModelResponse>;
}

export class ResponsesModel implements AgentModel {
  private turn = 0;
  constructor(
    readonly name: string,
    private readonly apiKey: string,
    private readonly emit: Emit,
    private readonly now: () => number,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {
    const url = new URL(baseUrl);
    if (
      url.href !== "https://api.openai.com/v1" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1")
    ) {
      throw new Error("Unsupported model endpoint");
    }
  }

  async respond(body: Record<string, unknown>): Promise<ModelResponse> {
    const turn = ++this.turn;
    const requestBody: Record<string, unknown> = {
      ...body,
      model: this.name,
      store: true,
      max_output_tokens: 2500,
    };
    const additionalParameters = Object.fromEntries(
      Object.entries(requestBody).filter(
        ([key]) =>
          ![
            "model",
            "store",
            "max_output_tokens",
            "parallel_tool_calls",
            "input",
            "instructions",
            "tools",
            "text",
          ].includes(key),
      ),
    );
    if (requestBody.text && typeof requestBody.text === "object") {
      const textParameters = Object.fromEntries(
        Object.entries(requestBody.text).filter(([key]) => key !== "format"),
      );
      if (Object.keys(textParameters).length)
        additionalParameters.text = textParameters;
    }
    this.emit({
      type: "model_started",
      turn,
      settings: {
        settings_version: 1,
        model: requestBody.model,
        store: requestBody.store,
        max_output_tokens: requestBody.max_output_tokens,
        parallel_tool_calls: requestBody.parallel_tool_calls,
        additional_parameters: additionalParameters,
      },
    });
    const start = this.now();
    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        redirect: "error",
        signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
      const result = (await response.json()) as ModelResponse;
      if (result.status !== "completed" || !Array.isArray(result.output)) {
        throw new Error("Incomplete model response");
      }
      this.emit({
        type: "model_finished",
        turn,
        outcome: "success",
        latency_ms: Math.max(0, this.now() - start),
        ...(result.usage?.input_tokens === undefined
          ? {}
          : { input_tokens: result.usage.input_tokens }),
        ...(result.usage?.output_tokens === undefined
          ? {}
          : { output_tokens: result.usage.output_tokens }),
      });
      return result;
    } catch {
      this.emit({
        type: "model_finished",
        turn,
        outcome: "error",
        latency_ms: Math.max(0, this.now() - start),
      });
      // Never print provider bodies, headers, or credentials.
      throw new Error("MODEL_REQUEST_FAILED");
    }
  }
}
