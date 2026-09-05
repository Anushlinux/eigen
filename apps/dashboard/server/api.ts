import { randomBytes } from "node:crypto";
import {
  executeRazorpaySmoke,
  prepareRazorpaySmoke,
  type RazorpaySmokeExecution,
  type RazorpaySmokeInput,
  type RazorpaySmokePreflight,
} from "@eigen/razorpay-smoke";
import { z } from "zod";
import { createExternalJobManager, ExternalJobError } from "./external-jobs.js";
import {
  DashboardReportError,
  type DashboardReportKind,
  listDashboardReports,
  readDashboardReport,
} from "./report-store.js";

const smokeInputSchema = z.object({
  paymentId: z
    .string()
    .trim()
    .regex(/^pay_[A-Za-z0-9_]+$/),
  amount: z.number().int().positive(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/),
  agent: z.literal("openai-refund-v3"),
  fault: z.literal("timeout-after-side-effect"),
});
const smokeConfirmationSchema = z.object({
  confirmationToken: z.string().min(16),
  typedPaymentId: z.string(),
  input: smokeInputSchema,
});

interface Confirmation {
  input: RazorpaySmokeInput;
  expiresAt: number;
}

export interface DashboardApiEnvironment {
  RAZORPAY_KEY_ID?: string | undefined;
  RAZORPAY_KEY_SECRET?: string | undefined;
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL?: string | undefined;
  EIGEN_ALLOW_RAZORPAY_TEST_WRITES?: string | undefined;
}

export interface DashboardApiDependencies {
  cwd: string;
  environment: DashboardApiEnvironment;
  now(): number;
  nextToken(): string;
  prepare(input: RazorpaySmokeInput): Promise<RazorpaySmokePreflight>;
  execute(input: RazorpaySmokeInput): Promise<RazorpaySmokeExecution>;
  externalJobs?: ReturnType<typeof createExternalJobManager> | undefined;
}

export function createDefaultDashboardApiDependencies(
  cwd: string,
  environment: DashboardApiEnvironment = process.env,
): DashboardApiDependencies {
  return {
    cwd,
    environment,
    now: () => Date.now(),
    nextToken: () => randomBytes(24).toString("base64url"),
    prepare: (input) => prepareRazorpaySmoke(input),
    execute: (input) => executeRazorpaySmoke(input, { cwd }),
    externalJobs: createExternalJobManager({ cwd, environment }),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function requireSafeWriteRequest(request: Request): Response | undefined {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json({ error: "Write requests must use application/json." }, 415);
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  return undefined;
}

export function createDashboardApi(
  dependencies: DashboardApiDependencies,
): (request: Request) => Promise<Response | undefined> {
  const confirmations = new Map<string, Confirmation>();
  const activePayments = new Set<string>();

  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return undefined;

    if (url.pathname.startsWith("/api/external/")) {
      const jobs = dependencies.externalJobs;
      if (!jobs)
        return json(
          { error: "External evaluation service is unavailable." },
          503,
        );
      try {
        await jobs.ready;
        if (
          request.method === "GET" &&
          url.pathname === "/api/external/config"
        ) {
          return json({ config: await jobs.getConfig() });
        }
        if (request.method === "GET" && url.pathname === "/api/external/jobs") {
          return json({ jobs: jobs.list() });
        }
        if (request.method === "GET") {
          const match = url.pathname.match(
            /^\/api\/external\/jobs\/([A-Za-z0-9_-]+)$/,
          );
          if (match?.[1]) {
            const job = jobs.get(match[1]);
            return job
              ? json({ job })
              : json({ error: "Evaluation job not found." }, 404);
          }
        }
        if (
          request.method === "POST" &&
          url.pathname === "/api/external/jobs"
        ) {
          const rejected = requireSafeWriteRequest(request);
          if (rejected) return rejected;
          const input = z
            .object({
              suite_id: z.literal("reviewed-refunds-v1"),
              trials: z.number().int().min(1).max(3),
              submission_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
            })
            .strict()
            .parse(await request.json());
          return json({ job: await jobs.start(input) }, 202);
        }
      } catch (error) {
        if (error instanceof ExternalJobError)
          return json({ error: error.message, code: error.code }, error.status);
        if (error instanceof z.ZodError || error instanceof SyntaxError)
          return json(
            {
              error:
                "Invalid evaluation request. Select a reviewed suite and 1–3 trials.",
            },
            400,
          );
        return json(
          {
            error:
              "The local evaluation service could not complete the request. Check its job status before retrying.",
          },
          503,
        );
      }
      return json({ error: "API route not found." }, 404);
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      const keyId = dependencies.environment.RAZORPAY_KEY_ID?.trim() ?? "";
      return json({
        razorpay_test_credentials_configured:
          keyId.startsWith("rzp_test_") &&
          Boolean(dependencies.environment.RAZORPAY_KEY_SECRET?.trim()),
        live_credentials_rejected: keyId.startsWith("rzp_live_"),
        openai_configured:
          Boolean(dependencies.environment.OPENAI_API_KEY?.trim()) &&
          Boolean(dependencies.environment.OPENAI_MODEL?.trim()),
        writes_enabled:
          dependencies.environment.EIGEN_ALLOW_RAZORPAY_TEST_WRITES === "1",
      });
    }

    if (request.method === "GET" && url.pathname === "/api/reports") {
      return json({ reports: await listDashboardReports(dependencies.cwd) });
    }

    if (request.method === "GET") {
      const match = url.pathname.match(
        /^\/api\/reports\/(comparison|smoke|external)\/([A-Za-z0-9_-]+)$/,
      );
      if (match) {
        const kind = match[1] as DashboardReportKind;
        const id = match[2];
        if (!id) return json({ error: "Report not found." }, 404);
        try {
          return json({
            report: await readDashboardReport(dependencies.cwd, kind, id),
          });
        } catch (error) {
          if (kind === "external" && error instanceof DashboardReportError) {
            return json(
              { error: error.message, code: error.code },
              error.status,
            );
          }
          return json({ error: "Report not found or invalid." }, 404);
        }
      }
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/razorpay/preflight"
    ) {
      const rejected = requireSafeWriteRequest(request);
      if (rejected) return rejected;
      try {
        const input = smokeInputSchema.parse(await request.json());
        const preflight = await dependencies.prepare({
          ...input,
          currency: input.currency.toUpperCase(),
        });
        const token = dependencies.nextToken();
        const expiresAt = dependencies.now() + 5 * 60_000;
        confirmations.set(token, {
          input: { ...input, currency: input.currency.toUpperCase() },
          expiresAt,
        });
        return json({
          preflight,
          confirmation_token: token,
          expires_at: new Date(expiresAt).toISOString(),
        });
      } catch (error) {
        return json({ error: safeMessage(error) }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/razorpay/smoke") {
      const rejected = requireSafeWriteRequest(request);
      if (rejected) return rejected;
      try {
        const body = smokeConfirmationSchema.parse(await request.json());
        const confirmation = confirmations.get(body.confirmationToken);
        confirmations.delete(body.confirmationToken);
        if (!confirmation || confirmation.expiresAt <= dependencies.now()) {
          return json(
            { error: "The confirmation token is invalid or expired." },
            409,
          );
        }
        const normalizedBody = {
          ...body.input,
          currency: body.input.currency.toUpperCase(),
        };
        if (
          JSON.stringify(confirmation.input) !==
            JSON.stringify(normalizedBody) ||
          body.typedPaymentId !== confirmation.input.paymentId
        ) {
          return json(
            { error: "The typed payment ID or preview no longer matches." },
            409,
          );
        }
        if (dependencies.environment.EIGEN_ALLOW_RAZORPAY_TEST_WRITES !== "1") {
          return json(
            { error: "Razorpay Test Mode writes are disabled on the server." },
            403,
          );
        }
        const paymentId = confirmation.input.paymentId ?? "";
        if (activePayments.has(paymentId)) {
          return json(
            { error: "A smoke run is already active for this payment." },
            409,
          );
        }
        activePayments.add(paymentId);
        try {
          const execution = await dependencies.execute(confirmation.input);
          return json(
            { report: execution.report },
            execution.report.result === "pass" ? 200 : 422,
          );
        } finally {
          activePayments.delete(paymentId);
        }
      } catch (error) {
        return json({ error: safeMessage(error) }, 400);
      }
    }

    return json({ error: "API route not found." }, 404);
  };
}
