// Visual test fixture only. No database, credentials, GitHub calls, or execution.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { FINANCIAL_EVALUATOR_VERSION } from "../../../packages/core/dist/index.js";
import {
  loadScenarios,
  reviewedSuiteDirectory,
} from "../../../packages/external-runner/dist/index.js";

const templates = await loadScenarios(reviewedSuiteDirectory);
const project = {
  id: "visual-fixture",
  ownerId: "fixture",
  repository: {
    id: 1,
    installationId: 1,
    owner: "Anushlinux",
    name: "eigen-refund-sample",
    defaultBranch: "main",
    private: false,
  },
  branch: "main",
  model: "gpt-5.6-luna",
  automaticRuns: true,
  integration: "ready",
  createdAt: "2026-09-05T12:00:00Z",
};
const tests = templates.map((scenario, index) => ({
  id: `test-${index}`,
  ownerId: "fixture",
  projectId: project.id,
  testId: `scenario-${index}`,
  version: 1,
  scenario,
  source: "reviewed",
  createdAt: project.createdAt,
}));
const first = templates[0];
if (!first) throw new Error("Missing visual scenario");
tests.push(
  ...[
    {
      id: "custom-v1",
      testId: "custom",
      version: 1,
      scenario: {
        ...first,
        id: "custom-refund",
        name: "Selected historical refund",
      },
    },
    {
      id: "custom-v2",
      testId: "custom",
      version: 2,
      scenario: { ...first, id: "custom-refund", name: "Revised refund test" },
    },
  ].map((test) => ({
    ...test,
    ownerId: "fixture",
    projectId: project.id,
    source: "custom",
    createdAt: project.createdAt,
  })),
);
const job = {
  id: "fixture-job",
  ownerId: "fixture",
  projectId: project.id,
  kind: "integration",
  status: "completed",
  commit: "a".repeat(40),
  model: project.model,
  evaluatorVersion: FINANCIAL_EVALUATOR_VERSION,
  testVersionIds: tests.filter((t) => t.version === 1).map((t) => t.id),
  comparisonRunId: null,
  pullRequestId: "fixture-pr",
  dedupeKey: "fixture",
  automatic: false,
  createdAt: project.createdAt,
  startedAt: project.createdAt,
  completedAt: "2026-09-05T12:03:00Z",
  lease: null,
  leaseUntil: null,
  cancelRequested: false,
  error: null,
  attempts: 1,
};
const detail = {
  project,
  tests,
  suites: [
    {
      id: "default",
      ownerId: "fixture",
      projectId: project.id,
      name: "Default suite",
      testVersionIds: tests.filter((t) => t.version === 1).map((t) => t.id),
    },
  ],
  jobs: [job],
  events: [
    "Read package.json and src/agent.ts.",
    "Located refund entrypoint and payment client.",
    "Updated eigen.json and src/eigen-adapter.ts.",
    "Build exited 0. TypeScript compilation completed.",
    "Completed integration check; 4 of 6 financial tests passed.",
    "Opened integration PR.",
  ].map((message, index) => ({
    id: `event-${index}`,
    ownerId: "fixture",
    projectId: project.id,
    jobId: job.id,
    time: `2026-09-05T12:0${Math.floor(index / 2)}:00Z`,
    stage: [
      "reading",
      "identifying",
      "editing",
      "building",
      "checking",
      "published",
    ][index],
    message,
  })),
  runs: [],
  pullRequests: [
    {
      id: "fixture-pr",
      ownerId: "fixture",
      projectId: project.id,
      jobId: job.id,
      number: 1,
      url: "#visual-fixture-only",
      baseCommit: job.commit,
      candidateCommit: "b".repeat(40),
      branch: "eigen/integration/fixture-job",
      kind: "integration",
      status: "open",
      draft: false,
      verified: true,
      changedFiles: ["eigen.json", "src/eigen-adapter.ts", ".eigen/README.md"],
      summary:
        "Visual fixture: added an execution adapter around the application and routed evaluation payment calls through the simulator. Application retry policy is unchanged.",
    },
  ],
};
const root = resolve("apps/dashboard/dist/client");
createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1:4175").pathname;
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end("Visual fixture is read-only");
    return;
  }
  const json =
    pathname === "/api/auth/config"
      ? { enabled: false }
      : pathname === "/api/platform/config"
        ? {
            setup: {
              ready: true,
              missing: [],
              githubReady: true,
              workerReady: true,
            },
            connection: { login: "visual-fixture" },
            installationUrl: null,
            templates,
          }
        : pathname === `/api/projects/${project.id}`
          ? detail
          : pathname === "/api/projects"
            ? {
                projects: [
                  {
                    ...project,
                    jobs: [job],
                    pullRequests: detail.pullRequests,
                    latestRun: null,
                  },
                ],
              }
            : null;
  if (json) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
    return;
  }
  let file = resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}/`)) file = resolve(root, "index.html");
  let body;
  try {
    body = await readFile(file);
  } catch {
    file = resolve(root, "index.html");
    body = await readFile(file);
  }
  if (extname(file) === ".html")
    body = Buffer.from(
      body
        .toString()
        .replace(
          "<body>",
          '<body><div style="padding:8px;background:#fff0bf;color:#111;text-align:center;font:14px sans-serif">UI verification fixture · no live agent job or PR</div>',
        ),
    );
  res.writeHead(200, {
    "Content-Type":
      { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
        extname(file)
      ] ?? "application/octet-stream",
  });
  res.end(body);
}).listen(4175, "127.0.0.1", () =>
  console.log(
    "Read-only UI fixture: http://127.0.0.1:4175/projects/visual-fixture/overview",
  ),
);
