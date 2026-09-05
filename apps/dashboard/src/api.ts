import type { ExternalSuiteReport } from "../server/external-report-schema";
import { authenticationHeaders, sessionExpiredEvent } from "./auth";
import type { ExternalJob, ExternalJobConfig } from "./external-job-types";
import type {
  ComparisonReport,
  DashboardStatus,
  ReportSummary,
  SmokeInput,
  SmokePreflight,
  SmokeReport,
} from "./types";

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(await authenticationHeaders()))
      headers.set(key, value);
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.message.includes("session expired"))
      window.dispatchEvent(new Event(sessionExpiredEvent));
    throw error;
  }
  if (response.status === 401)
    window.dispatchEvent(new Event(sessionExpiredEvent));
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(
      value.error ?? `Request failed with status ${response.status}.`,
    );
  }
  return value;
}

export async function fetchStatus(): Promise<DashboardStatus> {
  return apiJson<DashboardStatus>("/api/status");
}

export async function fetchReports(): Promise<ReportSummary[]> {
  const response = await apiJson<{ reports: ReportSummary[] }>("/api/reports");
  return response.reports;
}

export async function fetchComparison(id: string): Promise<ComparisonReport> {
  const response = await apiJson<{ report: ComparisonReport }>(
    `/api/reports/comparison/${encodeURIComponent(id)}`,
  );
  return response.report;
}

export async function fetchSmoke(id: string): Promise<SmokeReport> {
  const response = await apiJson<{ report: SmokeReport }>(
    `/api/reports/smoke/${encodeURIComponent(id)}`,
  );
  return response.report;
}

export async function fetchExternal(id: string): Promise<ExternalSuiteReport> {
  const response = await apiJson<{ report: ExternalSuiteReport }>(
    `/api/reports/external/${encodeURIComponent(id)}`,
  );
  return response.report;
}

export async function fetchExternalConfig(): Promise<ExternalJobConfig> {
  return (await apiJson<{ config: ExternalJobConfig }>("/api/external/config"))
    .config;
}

export async function fetchExternalJobs(): Promise<ExternalJob[]> {
  return (await apiJson<{ jobs: ExternalJob[] }>("/api/external/jobs")).jobs;
}

export async function fetchExternalJob(id: string): Promise<ExternalJob> {
  return (
    await apiJson<{ job: ExternalJob }>(
      `/api/external/jobs/${encodeURIComponent(id)}`,
    )
  ).job;
}

export async function startExternalJob(input: {
  suite_id: string;
  trials: number;
  submission_id: string;
}): Promise<ExternalJob> {
  return (
    await apiJson<{ job: ExternalJob }>("/api/external/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
  ).job;
}

export async function preflightSmoke(input: SmokeInput): Promise<{
  preflight: SmokePreflight;
  confirmation_token: string;
  expires_at: string;
}> {
  return apiJson("/api/razorpay/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function runSmoke(input: {
  input: SmokeInput;
  confirmationToken: string;
  typedPaymentId: string;
}): Promise<SmokeReport> {
  const response = await apiJson<{ report: SmokeReport }>(
    "/api/razorpay/smoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return response.report;
}
