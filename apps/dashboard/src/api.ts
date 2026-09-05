import type {
  ComparisonReport,
  DashboardStatus,
  ReportSummary,
  SmokeInput,
  SmokePreflight,
  SmokeReport,
} from "./types";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
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
