export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export interface RazorpayHttpRequest {
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  credentials: RazorpayCredentials;
}

export interface RazorpayHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface RazorpayHttpTransport {
  request(input: RazorpayHttpRequest): Promise<RazorpayHttpResponse>;
}

export class FetchRazorpayTransport implements RazorpayHttpTransport {
  constructor(private readonly baseUrl = "https://api.razorpay.com") {}

  async request(input: RazorpayHttpRequest): Promise<RazorpayHttpResponse> {
    const token = Buffer.from(
      `${input.credentials.keyId}:${input.credentials.keySecret}`,
      "utf8",
    ).toString("base64");
    const response = await fetch(`${this.baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        ...input.headers,
        Authorization: `Basic ${token}`,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const text = await response.text();
    let body: unknown = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { malformed_json: true };
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }
}
