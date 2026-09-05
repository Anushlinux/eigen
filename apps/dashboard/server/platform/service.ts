import { randomBytes, randomUUID } from "node:crypto";
import {
  FINANCIAL_EVALUATOR_VERSION,
  parseScenario,
  type Scenario,
} from "@eigen/core";
import type { AuthUser } from "../auth.js";
import type { GitHubProvider, GitHubToken } from "./github.js";
import { decrypt, digest, encrypt, redact, validWebhook } from "./security.js";
import {
  type Job,
  PlatformError,
  type PlatformSetup,
  type PlatformState,
  type PlatformStore,
  type Project,
  type Repository,
} from "./types.js";

export interface PlatformDependencies {
  store: PlatformStore;
  github?: GitHubProvider;
  tokenKey?: string;
  webhookSecret?: string;
  origin: string;
  model: string;
  templates: Scenario[];
  setup: PlatformSetup;
  draft?: (description: string, signal: AbortSignal) => Promise<Scenario>;
  nextId?: () => string;
  now?: () => Date;
}
export function ownedProject(state: PlatformState, owner: string, id: string) {
  const project = state.projects[id];
  if (!project || project.ownerId !== owner)
    throw new PlatformError(404, "Project not found.");
  return project;
}
export function appendEvent(
  state: PlatformState,
  job: Job,
  stage: string,
  message: string,
  id: string,
  time: string,
) {
  state.events[id] = {
    id,
    ownerId: job.ownerId,
    projectId: job.projectId,
    jobId: job.id,
    time,
    stage,
    message: redact(message),
  };
}
export function queueJob(
  state: PlatformState,
  project: Project,
  input: {
    kind: Job["kind"];
    commit: string;
    testVersionIds: string[];
    comparisonRunId?: string;
    pullRequestId?: string;
    model?: string;
    automatic?: boolean;
    force?: boolean;
  },
  id: string,
  time: string,
) {
  if (project.integration === "disconnected")
    throw new PlatformError(
      409,
      "Reconnect this repository before starting a job.",
    );
  const dedupeKey = digest(
    JSON.stringify([
      project.id,
      input.kind,
      input.commit,
      input.model ?? project.model,
      FINANCIAL_EVALUATOR_VERSION,
      [...input.testVersionIds].sort(),
      input.comparisonRunId ?? null,
    ]),
  );
  const prior = Object.values(state.jobs).find(
    (job) =>
      job.dedupeKey === dedupeKey &&
      (job.status === "queued" ||
        job.status === "running" ||
        (!input.force && job.status === "completed")),
  );
  if (prior) return prior;
  if (input.automatic) {
    const today = time.slice(0, 10);
    if (
      Object.values(state.jobs).filter(
        (job) =>
          job.projectId === project.id &&
          job.automatic &&
          job.createdAt.startsWith(today),
      ).length >= 20
    )
      return null;
    for (const job of Object.values(state.jobs)) {
      if (
        job.projectId === project.id &&
        job.automatic &&
        job.status === "queued" &&
        job.pullRequestId === (input.pullRequestId ?? null)
      ) {
        job.status = "cancelled";
        job.completedAt = time;
        job.error = "Superseded by a newer commit.";
      }
    }
  }
  const job: Job = {
    id,
    ownerId: project.ownerId,
    projectId: project.id,
    kind: input.kind,
    status: "queued",
    commit: input.commit,
    model: input.model ?? project.model,
    evaluatorVersion: FINANCIAL_EVALUATOR_VERSION,
    testVersionIds: [...input.testVersionIds],
    comparisonRunId: input.comparisonRunId ?? null,
    pullRequestId: input.pullRequestId ?? null,
    dedupeKey,
    automatic: input.automatic ?? false,
    createdAt: time,
    startedAt: null,
    completedAt: null,
    lease: null,
    leaseUntil: null,
    cancelRequested: false,
    error: null,
    attempts: 0,
  };
  state.jobs[id] = job;
  return job;
}

export function createPlatformService(deps: PlatformDependencies) {
  const nextId = deps.nextId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const time = () => now().toISOString();
  const publicJob = (job: Job) => {
    const { candidate: _candidate, ...value } = job;
    return value;
  };
  const github = () => {
    if (!deps.github || !deps.tokenKey)
      throw new PlatformError(
        503,
        "GitHub repository connection is not configured. Check the setup panel.",
      );
    return deps.github;
  };
  async function token(owner: string) {
    const connection = await deps.store.read(
      (state) => state.connections[owner],
    );
    if (!connection || !deps.tokenKey)
      throw new PlatformError(409, "Connect GitHub to select a repository.");
    if (
      connection.expiresAt &&
      new Date(connection.expiresAt).getTime() < now().getTime() + 60000
    ) {
      if (!connection.encryptedRefreshToken)
        throw new PlatformError(
          409,
          "Reconnect GitHub to renew repository access.",
        );
      const fresh = await github().refresh(
        decrypt(connection.encryptedRefreshToken, deps.tokenKey),
      );
      await saveConnection(owner, fresh, connection.githubId, connection.login);
      return fresh.access_token;
    }
    return decrypt(connection.encryptedToken, deps.tokenKey);
  }
  async function saveConnection(
    owner: string,
    value: GitHubToken,
    githubId: number,
    login: string,
  ) {
    const key = deps.tokenKey;
    if (!key)
      throw new PlatformError(503, "GitHub encryption is not configured.");
    await deps.store.transaction((state) => {
      state.connections[owner] = {
        id: owner,
        ownerId: owner,
        githubId,
        login,
        encryptedToken: encrypt(value.access_token, key),
        encryptedRefreshToken: value.refresh_token
          ? encrypt(value.refresh_token, key)
          : null,
        expiresAt: value.expires_in
          ? new Date(now().getTime() + value.expires_in * 1000).toISOString()
          : null,
      };
    });
  }
  async function accessible(owner: string, repository: Repository) {
    const repos = await github().repositories(await token(owner));
    const found = repos.find(
      (repo) =>
        repo.id === repository.id &&
        repo.installationId === repository.installationId,
    );
    if (!found)
      throw new PlatformError(
        409,
        "Repository access was removed. Update the Eigen GitHub App installation.",
      );
    return found;
  }
  function selectedTests(
    state: PlatformState,
    project: Project,
    ids?: string[],
  ) {
    const selected =
      ids ??
      Object.values(state.suites).find(
        (suite) => suite.projectId === project.id,
      )?.testVersionIds ??
      [];
    if (
      selected.length < 1 ||
      selected.length > 30 ||
      new Set(selected).size !== selected.length ||
      new Set(selected.map((id) => state.tests[id]?.testId)).size !==
        selected.length ||
      selected.some(
        (id) =>
          state.tests[id]?.projectId !== project.id ||
          state.tests[id]?.ownerId !== project.ownerId,
      )
    )
      throw new PlatformError(
        400,
        "Choose between 1 and 30 saved tests from this project.",
      );
    return selected;
  }
  return {
    deps,
    token,
    accessible,
    async configuration(user: AuthUser) {
      return deps.store.read((state) => ({
        setup: deps.setup,
        connection: state.connections[user.id]
          ? { login: state.connections[user.id]?.login }
          : null,
        installationUrl: deps.github?.installationUrl() ?? null,
        templates: deps.templates,
      }));
    },
    async connect(user: AuthUser) {
      const provider = github();
      const raw = randomBytes(32).toString("base64url");
      const verifier = randomBytes(32).toString("base64url");
      const id = digest(raw);
      await deps.store.transaction((state) => {
        for (const item of Object.values(state.oauthStates))
          if (item.expiresAt < time()) delete state.oauthStates[item.id];
        state.oauthStates[id] = {
          id,
          ownerId: user.id,
          verifier,
          expiresAt: new Date(now().getTime() + 600000).toISOString(),
        };
      });
      return {
        state: raw,
        url: provider.authorizeUrl(
          raw,
          Buffer.from(digest(verifier), "hex").toString("base64url"),
        ),
      };
    },
    async callback(code: string, rawState: string, cookie: string) {
      if (!rawState || digest(rawState) !== cookie)
        throw new PlatformError(
          400,
          "GitHub connection expired or was started in another browser. Start again.",
        );
      const saved = await deps.store.transaction((state) => {
        const item = state.oauthStates[digest(rawState)];
        if (!item || item.expiresAt < time())
          throw new PlatformError(
            400,
            "GitHub connection expired. Start again.",
          );
        delete state.oauthStates[item.id];
        return item;
      });
      const value = await github().exchange(code, saved.verifier);
      const identity = await github().user(value.access_token);
      await saveConnection(saved.ownerId, value, identity.id, identity.login);
    },
    async repositories(user: AuthUser) {
      return github().repositories(await token(user.id));
    },
    async branches(user: AuthUser, repositoryId: number) {
      const access = await token(user.id);
      const repository = (await github().repositories(access)).find(
        (repo) => repo.id === repositoryId,
      );
      if (!repository) throw new PlatformError(404, "Repository not found.");
      return github().branches(access, repository);
    },
    async projects(user: AuthUser) {
      return deps.store.read((state) =>
        Object.values(state.projects)
          .filter((project) => project.ownerId === user.id)
          .map((project) => ({
            ...project,
            jobs: Object.values(state.jobs)
              .filter((job) => job.projectId === project.id)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .slice(0, 3)
              .map(publicJob),
            pullRequests: Object.values(state.pullRequests).filter(
              (pr) => pr.projectId === project.id,
            ),
            latestRun:
              Object.values(state.runs)
                .filter((run) => run.projectId === project.id)
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 1)
                .map(({ report, ...run }) => ({
                  ...run,
                  decision: report.decision,
                }))[0] ?? null,
          })),
      );
    },
    async createProject(user: AuthUser, repositoryId: number, branch: string) {
      const access = await token(user.id);
      const repo = (await github().repositories(access)).find(
        (item) => item.id === repositoryId,
      );
      if (!repo) throw new PlatformError(404, "Repository not found.");
      if (!(await github().branches(access, repo)).includes(branch))
        throw new PlatformError(400, "Select an existing repository branch.");
      const commit = await github().resolve(repo, branch);
      return deps.store.transaction((state) => {
        const existing = Object.values(state.projects).find(
          (project) =>
            project.ownerId === user.id && project.repository.id === repo.id,
        );
        if (existing) {
          if (existing.integration === "disconnected") {
            existing.repository = repo;
            existing.branch = branch;
            existing.integration = "pending";
            queueJob(
              state,
              existing,
              {
                kind: "integration",
                commit,
                testVersionIds: selectedTests(state, existing),
                force: true,
              },
              nextId(),
              time(),
            );
          }
          return existing;
        }
        if (
          Object.values(state.projects).filter(
            (project) => project.ownerId === user.id,
          ).length >= 10
        )
          throw new PlatformError(
            409,
            "The pilot supports up to ten projects per user.",
          );
        const id = nextId();
        const project: Project = {
          id,
          ownerId: user.id,
          repository: repo,
          branch,
          model: deps.model,
          automaticRuns: true,
          integration: "pending",
          createdAt: time(),
        };
        state.projects[id] = project;
        const versions = deps.templates.map((scenario) => {
          const versionId = nextId();
          state.tests[versionId] = {
            id: versionId,
            ownerId: user.id,
            projectId: id,
            testId: scenario.id,
            version: 1,
            scenario,
            source: "reviewed",
            createdAt: time(),
          };
          return versionId;
        });
        const suiteId = nextId();
        state.suites[suiteId] = {
          id: suiteId,
          ownerId: user.id,
          projectId: id,
          name: "Refund safety suite",
          testVersionIds: versions,
        };
        queueJob(
          state,
          project,
          { kind: "integration", commit, testVersionIds: versions },
          nextId(),
          time(),
        );
        return project;
      });
    },
    async project(user: AuthUser, id: string) {
      return deps.store.read((state) => {
        const project = ownedProject(state, user.id, id);
        return {
          project,
          tests: Object.values(state.tests).filter(
            (test) => test.projectId === id,
          ),
          suites: Object.values(state.suites).filter(
            (suite) => suite.projectId === id,
          ),
          jobs: Object.values(state.jobs)
            .filter((job) => job.projectId === id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(publicJob),
          events: Object.values(state.events)
            .filter((event) => event.projectId === id)
            .sort((a, b) => a.time.localeCompare(b.time))
            .slice(-300),
          runs: Object.values(state.runs)
            .filter((run) => run.projectId === id)
            .map(({ report, ...run }) => ({
              ...run,
              decision: report.decision,
              passed: report.runs.filter(
                (trial) => trial.report.deployment_decision === "allow",
              ).length,
              total: report.runs.length,
            })),
          pullRequests: Object.values(state.pullRequests).filter(
            (pr) => pr.projectId === id,
          ),
        };
      });
    },
    async updateProject(
      user: AuthUser,
      id: string,
      input: {
        branch?: string | undefined;
        automaticRuns?: boolean | undefined;
        disconnect?: boolean | undefined;
      },
    ) {
      const project = await deps.store.read((state) =>
        ownedProject(state, user.id, id),
      );
      if (input.branch) {
        await accessible(user.id, project.repository);
        if (
          !(
            await github().branches(await token(user.id), project.repository)
          ).includes(input.branch)
        )
          throw new PlatformError(400, "Select an existing branch.");
      }
      return deps.store.transaction((state) => {
        const project = ownedProject(state, user.id, id);
        if (input.branch) project.branch = input.branch;
        if (input.automaticRuns !== undefined)
          project.automaticRuns = input.automaticRuns;
        if (input.disconnect) {
          project.integration = "disconnected";
          project.automaticRuns = false;
          for (const job of Object.values(state.jobs))
            if (
              job.projectId === id &&
              ["queued", "running"].includes(job.status)
            ) {
              job.cancelRequested = true;
              if (job.status === "queued") {
                job.status = "cancelled";
                job.completedAt = time();
              }
            }
        }
        return project;
      });
    },
    async saveTest(
      user: AuthUser,
      id: string,
      input: unknown,
      testId?: string,
    ) {
      let scenario: Scenario;
      try {
        scenario = parseScenario(input);
      } catch {
        throw new PlatformError(
          400,
          "The scenario is invalid. Check payment balance, currency, authorization, and expected behavior.",
        );
      }
      return deps.store.transaction((state) => {
        ownedProject(state, user.id, id);
        const prior = Object.values(state.tests).filter(
          (test) => test.projectId === id && test.testId === testId,
        );
        if (prior.some((test) => test.source === "reviewed"))
          throw new PlatformError(
            409,
            "Reviewed tests are immutable. Save a custom copy.",
          );
        if (
          Object.values(state.tests).filter((test) => test.projectId === id)
            .length >= 300
        )
          throw new PlatformError(
            409,
            "This project reached the pilot's test-version limit.",
          );
        const versionId = nextId();
        if (testId && !prior.length)
          throw new PlatformError(404, "Test not found in this project.");
        const stableId = testId ?? nextId();
        const test = {
          id: versionId,
          ownerId: user.id,
          projectId: id,
          testId: stableId,
          version: Math.max(0, ...prior.map((test) => test.version)) + 1,
          scenario: {
            ...scenario,
            id: prior[0]?.scenario.id ?? `custom-${stableId}`,
          },
          source: "custom" as const,
          createdAt: time(),
        };
        state.tests[versionId] = test;
        const suite = Object.values(state.suites).find(
          (suite) => suite.projectId === id,
        );
        if (suite)
          suite.testVersionIds = [
            ...suite.testVersionIds.filter(
              (version) => state.tests[version]?.testId !== test.testId,
            ),
            versionId,
          ].slice(0, 30);
        return test;
      });
    },
    async draft(user: AuthUser, id: string, description: string) {
      await deps.store.read((state) => ownedProject(state, user.id, id));
      if (!deps.draft)
        throw new PlatformError(503, "AI test drafting is not configured.");
      return parseScenario(
        await deps.draft(description, AbortSignal.timeout(60000)),
      );
    },
    async saveSuite(
      user: AuthUser,
      projectId: string,
      suiteId: string,
      testVersionIds: string[],
    ) {
      return deps.store.transaction((state) => {
        const project = ownedProject(state, user.id, projectId);
        const suite = state.suites[suiteId];
        if (!suite || suite.projectId !== projectId)
          throw new PlatformError(404, "Suite not found.");
        suite.testVersionIds = selectedTests(state, project, testVersionIds);
        return suite;
      });
    },
    async run(
      user: AuthUser,
      id: string,
      input: {
        kind: Job["kind"];
        testVersionIds?: string[] | undefined;
        pullRequestId?: string | undefined;
        runId?: string | undefined;
        force?: boolean | undefined;
      },
    ) {
      if (input.runId && input.kind !== "repair")
        throw new PlatformError(
          400,
          "A source run is supported only for a repair.",
        );
      if (!deps.setup.workerReady)
        throw new PlatformError(
          503,
          "Execution is not configured. Complete the setup panel before starting a job.",
        );
      const project = await deps.store.read((state) =>
        ownedProject(state, user.id, id),
      );
      await accessible(user.id, project.repository);
      const saved = await deps.store.read((state) => {
        const testVersionIds = selectedTests(
          state,
          project,
          input.testVersionIds,
        );
        const run = input.runId ? state.runs[input.runId] : null;
        const pr = input.pullRequestId
          ? state.pullRequests[input.pullRequestId]
          : null;
        if (
          input.kind === "repair" &&
          (!run ||
            run.projectId !== id ||
            run.ownerId !== user.id ||
            run.report.decision !== "block")
        )
          throw new PlatformError(
            400,
            "Select a failed run from this project to request a repair.",
          );
        if (input.pullRequestId && (!pr || pr.projectId !== id))
          throw new PlatformError(404, "Pull request not found.");
        return {
          tests: run?.testVersionIds ?? testVersionIds,
          commit: run?.commit ?? pr?.candidateCommit ?? null,
          prId: pr?.id,
          model: run?.model ?? project.model,
        };
      });
      const commit =
        saved.commit ??
        (await github().resolve(project.repository, project.branch));
      return deps.store.transaction((state) =>
        queueJob(
          state,
          ownedProject(state, user.id, id),
          {
            kind: input.kind,
            commit,
            testVersionIds: saved.tests,
            model: saved.model,
            ...(input.runId ? { comparisonRunId: input.runId } : {}),
            ...(saved.prId ? { pullRequestId: saved.prId } : {}),
            force: input.force ?? false,
          },
          nextId(),
          time(),
        ),
      );
    },
    async runReport(user: AuthUser, id: string, runId: string) {
      return deps.store.read((state) => {
        ownedProject(state, user.id, id);
        const run = state.runs[runId];
        if (!run || run.projectId !== id || run.ownerId !== user.id)
          throw new PlatformError(404, "Run not found.");
        return run;
      });
    },
    async cancel(user: AuthUser, id: string, jobId: string) {
      return deps.store.transaction((state) => {
        ownedProject(state, user.id, id);
        const job = state.jobs[jobId];
        if (!job || job.projectId !== id)
          throw new PlatformError(404, "Job not found.");
        job.cancelRequested = true;
        if (job.status === "queued") {
          job.status = "cancelled";
          job.completedAt = time();
        }
        return job;
      });
    },
    async webhook(
      body: string,
      signature: string,
      delivery: string,
      event: string,
    ) {
      if (
        !deps.webhookSecret ||
        !validWebhook(body, signature, deps.webhookSecret)
      )
        throw new PlatformError(401, "Invalid webhook signature.");
      if (!delivery || delivery.length > 200)
        throw new PlatformError(400, "Missing webhook delivery ID.");
      const payload = JSON.parse(body) as {
        action?: string;
        installation?: { id: number };
        repositories_removed?: { id: number }[];
        repository?: { id: number };
        ref?: string;
        after?: string;
        deleted?: boolean;
        review?: { state: string; commit_id: string };
        pull_request?: {
          number: number;
          state: string;
          merged: boolean;
          draft: boolean;
          html_url?: string;
          base?: { sha: string };
          head: { sha: string; ref?: string; repo: { id: number } | null };
        };
      };
      return deps.store.transaction((state) => {
        if (state.receipts[delivery]) return { duplicate: true };
        state.receipts[delivery] = {
          id: delivery,
          ownerId: "system",
          createdAt: time(),
        };
        for (const project of Object.values(state.projects)) {
          if (project.repository.installationId !== payload.installation?.id)
            continue;
          if (
            (event === "installation" &&
              ["deleted", "suspend"].includes(payload.action ?? "")) ||
            payload.repositories_removed?.some(
              (repo) => repo.id === project.repository.id,
            )
          ) {
            project.integration = "disconnected";
            for (const job of Object.values(state.jobs))
              if (
                job.projectId === project.id &&
                ["queued", "running"].includes(job.status)
              ) {
                job.cancelRequested = true;
                if (job.status === "queued") job.status = "cancelled";
              }
            continue;
          }
          if (project.repository.id !== payload.repository?.id) continue;
          const prPayload = payload.pull_request;
          let pr = prPayload
            ? Object.values(state.pullRequests).find(
                (item) =>
                  item.projectId === project.id &&
                  item.number === prPayload.number,
              )
            : undefined;
          if (
            !pr &&
            prPayload?.head.repo?.id === project.repository.id &&
            prPayload.head.ref &&
            prPayload.base?.sha
          ) {
            const prId = nextId();
            pr = state.pullRequests[prId] = {
              id: prId,
              ownerId: project.ownerId,
              projectId: project.id,
              jobId: "",
              number: prPayload.number,
              url: `https://github.com/${encodeURIComponent(project.repository.owner)}/${encodeURIComponent(project.repository.name)}/pull/${prPayload.number}`,
              baseCommit: prPayload.base.sha,
              candidateCommit: prPayload.head.sha,
              branch: prPayload.head.ref,
              kind: "repository",
              status: "open",
              draft: prPayload.draft,
              verified: false,
              changedFiles: [],
              summary:
                "Repository pull request connected through GitHub. Eigen results refer to its exact commit.",
            };
          }
          if (pr && prPayload) {
            pr.status = prPayload.merged
              ? "merged"
              : prPayload.state === "closed"
                ? "closed"
                : "open";
            pr.draft = prPayload.draft;
            if (pr.candidateCommit !== prPayload.head.sha) {
              pr.verified = false;
              delete pr.reviewStatus;
            }
            if (
              event === "pull_request_review" &&
              payload.review?.commit_id === prPayload.head.sha &&
              [
                "approved",
                "changes_requested",
                "commented",
                "dismissed",
              ].includes(payload.review.state.toLowerCase())
            )
              pr.reviewStatus =
                payload.review.state.toLowerCase() as NonNullable<
                  typeof pr.reviewStatus
                >;
            pr.candidateCommit = prPayload.head.sha;
          }
          if (!project.automaticRuns || project.integration !== "ready")
            continue;
          const commit =
            event === "push" &&
            !payload.deleted &&
            payload.ref === `refs/heads/${project.branch}`
              ? payload.after
              : event === "pull_request" &&
                  prPayload?.head.repo?.id === project.repository.id &&
                  ["opened", "reopened", "synchronize"].includes(
                    payload.action ?? "",
                  )
                ? prPayload.head.sha
                : null;
          if (commit && /^[a-f0-9]{40}$/.test(commit))
            queueJob(
              state,
              project,
              {
                kind: "evaluation",
                commit,
                testVersionIds: selectedTests(state, project),
                automatic: true,
                ...(pr ? { pullRequestId: pr.id } : {}),
              },
              nextId(),
              time(),
            );
        }
        return { duplicate: false };
      });
    },
  };
}
export type PlatformService = ReturnType<typeof createPlatformService>;
