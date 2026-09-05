import type { Scenario } from "@eigen/core";
import type { ExternalSuiteReport } from "@eigen/external-runner";

export interface Repository {
  id: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}
export interface Project {
  id: string;
  ownerId: string;
  repository: Repository;
  branch: string;
  model: string;
  automaticRuns: boolean;
  integration:
    | "pending"
    | "working"
    | "ready"
    | "needs_configuration"
    | "disconnected";
  createdAt: string;
}
export interface Connection {
  id: string;
  ownerId: string;
  githubId: number;
  login: string;
  encryptedToken: string;
  encryptedRefreshToken: string | null;
  expiresAt: string | null;
}
export interface TestVersion {
  id: string;
  ownerId: string;
  projectId: string;
  testId: string;
  version: number;
  scenario: Scenario;
  source: "reviewed" | "custom";
  createdAt: string;
}
export interface Suite {
  id: string;
  ownerId: string;
  projectId: string;
  name: string;
  testVersionIds: string[];
}
export type JobKind = "integration" | "evaluation" | "repair";
export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled";
export interface Job {
  id: string;
  ownerId: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  commit: string;
  model: string;
  testVersionIds: string[];
  comparisonRunId: string | null;
  pullRequestId: string | null;
  evaluatorVersion: string;
  dedupeKey: string;
  automatic: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lease: string | null;
  leaseUntil: string | null;
  cancelRequested: boolean;
  error: string | null;
  attempts: number;
  candidate?: {
    files: Record<string, string>;
    summary: string;
    verified: boolean;
    report: ExternalSuiteReport | null;
  };
}
export interface JobEvent {
  id: string;
  ownerId: string;
  projectId: string;
  jobId: string;
  time: string;
  stage: string;
  message: string;
}
export interface ProjectRun {
  id: string;
  ownerId: string;
  projectId: string;
  jobId: string;
  commit: string;
  testVersionIds: string[];
  model: string;
  createdAt: string;
  report: ExternalSuiteReport;
}
export interface PullRequest {
  id: string;
  ownerId: string;
  projectId: string;
  jobId: string;
  number: number;
  url: string;
  baseCommit: string;
  candidateCommit: string;
  branch: string;
  kind: "integration" | "repair" | "repository";
  status: "open" | "closed" | "merged";
  draft: boolean;
  reviewStatus?: "approved" | "changes_requested" | "commented" | "dismissed";
  verified: boolean;
  changedFiles: string[];
  summary: string;
}
export interface OAuthState {
  id: string;
  ownerId: string;
  verifier: string;
  expiresAt: string;
}
export interface Receipt {
  id: string;
  ownerId: string;
  createdAt: string;
}
export interface PlatformState {
  projects: Record<string, Project>;
  connections: Record<string, Connection>;
  tests: Record<string, TestVersion>;
  suites: Record<string, Suite>;
  jobs: Record<string, Job>;
  events: Record<string, JobEvent>;
  runs: Record<string, ProjectRun>;
  pullRequests: Record<string, PullRequest>;
  oauthStates: Record<string, OAuthState>;
  receipts: Record<string, Receipt>;
}
export const collections = [
  "projects",
  "connections",
  "tests",
  "suites",
  "jobs",
  "events",
  "runs",
  "pullRequests",
  "oauthStates",
  "receipts",
] as const;
export const emptyState = (): PlatformState =>
  Object.fromEntries(
    collections.map((name) => [name, {}]),
  ) as unknown as PlatformState;
export interface PlatformStore {
  read<T>(fn: (state: PlatformState) => T): Promise<T>;
  transaction<T>(fn: (state: PlatformState) => T): Promise<T>;
  close(): Promise<void>;
}
export class PlatformError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface PlatformSetup {
  ready: boolean;
  missing: string[];
  githubReady: boolean;
  workerReady: boolean;
}
