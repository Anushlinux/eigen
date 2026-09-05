import type { Scenario } from "@eigen/core";
import { useCallback, useEffect, useState } from "react";
import type { PlatformService } from "../server/platform/service";
import type { Job, PlatformSetup, Repository } from "../server/platform/types";
import { apiJson } from "./api";
import { ProjectRunDetail } from "./ProjectRunDetail";
import { ProjectTestEditor } from "./ProjectTestEditor";
import "./projects.css";

type ProjectList = Awaited<ReturnType<PlatformService["projects"]>>;
type Detail = Awaited<ReturnType<PlatformService["project"]>>;
type Configuration = {
  setup: PlatformSetup;
  connection: { login: string } | null;
  installationUrl: string | null;
  templates: Scenario[];
};
const tabs = [
  ["overview", "Overview"],
  ["tests", "Tests"],
  ["runs", "Runs"],
  ["agent", "Agent activity"],
  ["settings", "Settings"],
] as const;
const status = (value: string) => value.replaceAll("_", " ");
const activeJob = (job: Job) =>
  job.status === "queued" || job.status === "running";
function go(path: string) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
const post = <T,>(path: string, body: unknown) =>
  apiJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const projectPath = (id: string, tab = "overview") =>
  `/projects/${encodeURIComponent(id)}/${tab}`;

export function ProjectsApp() {
  const [path, setPath] = useState(window.location.pathname);
  const [config, setConfig] = useState<Configuration>();
  const [projects, setProjects] = useState<ProjectList>([]);
  const [detail, setDetail] = useState<Detail>();
  const [error, setError] = useState(
    new URLSearchParams(window.location.search).get("error") ?? "",
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const parts = path.split("/").filter(Boolean);
  const adding = parts[1] === "new";
  const projectId =
    parts[0] === "projects" && parts[1] && !adding ? parts[1] : null;
  const tab = parts[2] ?? "overview";
  const runId = tab === "runs" ? parts[3] : undefined;
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly reloads saved server state.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setDetail(undefined);
    void (async () => {
      const nextConfig = await apiJson<Configuration>("/api/platform/config");
      if (!live) return;
      setConfig(nextConfig);
      if (
        nextConfig.setup.missing.some(
          (key) => key.includes("migration") || key === "DATABASE_URL",
        )
      ) {
        setLoading(false);
        return;
      }
      if (projectId) {
        const value = await apiJson<Detail>(`/api/projects/${projectId}`);
        if (live) setDetail(value);
      } else {
        const value = await apiJson<{ projects: ProjectList }>("/api/projects");
        if (live) setProjects(value.projects);
      }
    })()
      .catch((reason: unknown) => {
        if (live)
          setError(
            reason instanceof Error
              ? reason.message
              : "Projects could not be loaded.",
          );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [projectId, revision]);
  useEffect(() => {
    if (!projectId || !detail?.jobs.some(activeJob)) return;
    let live = true;
    const timer = setInterval(() => {
      void apiJson<Detail>(`/api/projects/${projectId}`)
        .then((next) => {
          if (live) setDetail(next);
        })
        .catch(() => {
          if (live)
            setError(
              "Live updates paused. Refresh to reconnect; your job continues on the server.",
            );
        });
    }, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId, detail?.jobs]);
  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      refresh();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function start(
    kind: Job["kind"],
    options: Record<string, unknown> = {},
  ) {
    if (!projectId) return;
    await action(async () => {
      await post(`/api/projects/${projectId}/jobs`, { kind, ...options });
      go(projectPath(projectId, kind === "evaluation" ? "runs" : "agent"));
    });
  }
  const current = detail?.project;
  return (
    <div className="project-shell">
      <header className="project-topbar">
        <a
          className="wordmark"
          href="/projects"
          onClick={(event) => {
            event.preventDefault();
            go("/projects");
          }}
        >
          EIGEN
        </a>
        <nav aria-label="Workspace">
          <a
            href="/projects"
            onClick={(event) => {
              event.preventDefault();
              go("/projects");
            }}
            aria-current={!projectId ? "page" : undefined}
          >
            Projects
          </a>
          {current && (
            <span>
              {current.repository.owner} / {current.repository.name}
            </span>
          )}
        </nav>
        <span className="project-environment">Simulated payments</span>
      </header>
      <main className="project-main">
        {error && (
          <div role="alert" className="project-error">
            {error}
            <button
              type="button"
              onClick={() => {
                setError("");
                refresh();
              }}
            >
              Retry
            </button>
          </div>
        )}
        {config && !config.setup.ready && (
          <SetupNotice configuration={config} />
        )}
        {loading ? (
          <p role="status" className="project-loading">
            Loading your workspace…
          </p>
        ) : adding ? (
          <AddRepository config={config} busy={busy} action={action} />
        ) : !projectId ? (
          <>
            <header className="project-page-heading">
              <div>
                <h1>Projects</h1>
                <p>
                  Connect your refund agent. Review its integration, run tests,
                  and track verified changes.
                </p>
              </div>
              <button
                type="button"
                className="project-primary"
                onClick={() => go("/projects/new")}
              >
                Add repository
              </button>
            </header>
            {!projects.length ? (
              <section className="project-empty">
                <h2>Your agent’s next step starts here.</h2>
                <p>
                  Add a GitHub repository. Eigen’s coding agent will read the
                  application, prepare an evaluation integration, and open a PR
                  for your review.
                </p>
                <ol>
                  <li>Choose a repository</li>
                  <li>Review the integration PR</li>
                  <li>Create and run your tests</li>
                </ol>
                <button
                  type="button"
                  className="project-primary"
                  onClick={() => go("/projects/new")}
                >
                  Connect your first repository
                </button>
              </section>
            ) : (
              <div className="project-list">
                {projects.map((project) => (
                  <a
                    className="project-row"
                    key={project.id}
                    href={projectPath(project.id)}
                    onClick={(event) => {
                      event.preventDefault();
                      go(projectPath(project.id));
                    }}
                  >
                    <div>
                      <h2>{project.repository.name}</h2>
                      <p>
                        {project.repository.owner} · {project.branch}
                      </p>
                    </div>
                    <div>
                      <span
                        className={`project-status status-${project.integration}`}
                      >
                        {status(project.integration)}
                      </span>
                      <p>
                        {project.latestRun
                          ? project.latestRun.decision === "allow"
                            ? "Latest tests passed"
                            : "Latest tests found failures"
                          : "No evaluations yet"}
                      </p>
                    </div>
                    <div>
                      <p>
                        {project.jobs.find(activeJob)
                          ? `${project.jobs.find(activeJob)?.kind} in progress`
                          : project.pullRequests.find(
                                (pr) => pr.status === "open",
                              )
                            ? `PR #${project.pullRequests.find((pr) => pr.status === "open")?.number} awaiting review`
                            : "Open project"}
                      </p>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </>
        ) : detail && current ? (
          <>
            <header className="project-page-heading">
              <div>
                <h1>{current.repository.name}</h1>
                <p>
                  <a
                    href={`https://github.com/${current.repository.owner}/${current.repository.name}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {current.repository.owner}/{current.repository.name}
                  </a>{" "}
                  · tracking {current.branch}
                </p>
              </div>
              <span className={`project-status status-${current.integration}`}>
                Integration: {status(current.integration)}
              </span>
            </header>
            <nav className="project-tabs" aria-label="Project">
              {tabs.map(([key, label]) => (
                <a
                  key={key}
                  href={projectPath(current.id, key)}
                  aria-current={tab === key ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    go(projectPath(current.id, key));
                  }}
                >
                  {label}
                </a>
              ))}
            </nav>
            {tab === "overview" && (
              <>
                <section className="project-next">
                  <div>
                    <h2>
                      {detail.jobs.some(activeJob)
                        ? "Your agent is working"
                        : current.integration === "ready"
                          ? "Ready to evaluate your application"
                          : current.integration === "needs_configuration"
                            ? "Integration needs attention"
                            : "Preparing your evaluation integration"}
                    </h2>
                    <p>
                      {current.integration === "ready"
                        ? "Run tests against the tracked branch or the integration PR. A working integration and passing financial tests are separate results."
                        : "Follow the actual agent activity and review its changes before merging the integration."}
                    </p>
                  </div>
                  <div className="project-actions">
                    <button
                      type="button"
                      className="project-primary"
                      disabled={
                        busy ||
                        !config?.setup.workerReady ||
                        current.integration !== "ready"
                      }
                      onClick={() => go(projectPath(current.id, "tests"))}
                    >
                      Choose tests and source
                    </button>
                    <button
                      type="button"
                      onClick={() => go(projectPath(current.id, "agent"))}
                    >
                      View agent activity
                    </button>
                  </div>
                </section>
                <PullRequests
                  detail={detail}
                  busy={busy}
                  onRun={(id) =>
                    void start("evaluation", { pullRequestId: id })
                  }
                />
                <section className="project-section">
                  <header className="project-section-heading">
                    <h2>Latest evaluations</h2>
                    <a
                      href={projectPath(current.id, "tests")}
                      onClick={(event) => {
                        event.preventDefault();
                        go(projectPath(current.id, "tests"));
                      }}
                    >
                      {detail.tests.length} saved test versions
                    </a>
                  </header>
                  <RunList detail={detail} />
                </section>
              </>
            )}
            {tab === "tests" && (
              <ProjectTests
                detail={detail}
                templates={config?.templates ?? []}
                busy={busy}
                refresh={refresh}
                onRun={(ids, pullRequestId) =>
                  void start("evaluation", {
                    testVersionIds: ids,
                    ...(pullRequestId ? { pullRequestId } : {}),
                  })
                }
              />
            )}
            {tab === "runs" &&
              (runId ? (
                <ProjectRunDetail
                  projectId={current.id}
                  runId={runId}
                  baselineId={
                    detail.jobs.find(
                      (job) =>
                        job.id ===
                        detail.runs.find((run) => run.id === runId)?.jobId,
                    )?.comparisonRunId ?? undefined
                  }
                  busy={busy}
                  onRepair={(id) => void start("repair", { runId: id })}
                />
              ) : (
                <section className="project-section">
                  <header className="project-section-heading">
                    <div>
                      <h2>Evaluation runs</h2>
                      <p>
                        Every result belongs to an exact commit and saved test
                        versions.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="project-primary"
                      disabled={busy || !config?.setup.workerReady}
                      onClick={() => go(projectPath(current.id, "tests"))}
                    >
                      Choose tests and source
                    </button>
                  </header>
                  {detail.jobs
                    .filter(
                      (job) => job.kind === "evaluation" && activeJob(job),
                    )
                    .map((job) => (
                      <p key={job.id} role="status">
                        {status(job.status)} · {job.commit.slice(0, 12)}
                      </p>
                    ))}
                  <RunList detail={detail} />
                </section>
              ))}
            {tab === "agent" && (
              <section className="project-section">
                <header className="project-section-heading">
                  <div>
                    <h2>Agent activity</h2>
                    <p>
                      Real actions and results. Integration and repair stop
                      after five minutes or 20 agent turns.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      detail.jobs.some(activeJob) ||
                      !config?.setup.workerReady
                    }
                    onClick={() => void start("integration", { force: true })}
                  >
                    Retry integration
                  </button>
                </header>
                {detail.jobs.map((job) => (
                  <section className="project-job" key={job.id}>
                    <header>
                      <h3>
                        {job.kind === "integration"
                          ? "Integrate with Eigen"
                          : job.kind === "repair"
                            ? "Repair recorded failure"
                            : "Evaluate application"}
                      </h3>
                      <span className={`project-status status-${job.status}`}>
                        {status(job.status)}
                      </span>
                      {activeJob(job) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void action(() =>
                              post(
                                `/api/projects/${current.id}/jobs/${job.id}/cancel`,
                                {},
                              ),
                            )
                          }
                        >
                          Cancel job
                        </button>
                      )}
                    </header>
                    <p>
                      <code>{job.commit.slice(0, 12)}</code> ·{" "}
                      {new Date(job.createdAt).toLocaleString()}
                    </p>
                    {job.error && <p className="project-error">{job.error}</p>}
                    <ol className="project-timeline">
                      {detail.events
                        .filter((event) => event.jobId === job.id)
                        .map((event) => (
                          <li key={event.id}>
                            <time>
                              {new Date(event.time).toLocaleTimeString()}
                            </time>
                            <div>
                              <strong>{status(event.stage)}</strong>
                              <p>{event.message}</p>
                            </div>
                          </li>
                        ))}
                    </ol>
                    {!detail.events.some((event) => event.jobId === job.id) && (
                      <p>
                        Queued for the repository worker. Activity appears when
                        execution begins.
                      </p>
                    )}
                  </section>
                ))}
                <PullRequests
                  detail={detail}
                  busy={busy}
                  onRun={(id) =>
                    void start("evaluation", { pullRequestId: id })
                  }
                />
              </section>
            )}
            {tab === "settings" && (
              <ProjectSettings detail={detail} busy={busy} action={action} />
            )}
          </>
        ) : (
          <section className="project-empty">
            <h1>Project unavailable</h1>
            <p>Check repository access or return to your projects.</p>
            <button type="button" onClick={() => go("/projects")}>
              Back to projects
            </button>
          </section>
        )}
      </main>
      <footer className="project-footer">
        <span>Financial correctness is decided by deterministic code.</span>
        {["127.0.0.1", "localhost"].includes(window.location.hostname) && (
          <a href="/local">Open existing local reports</a>
        )}
      </footer>
    </div>
  );
}

function SetupNotice({ configuration }: { configuration: Configuration }) {
  return (
    <aside className="project-setup">
      <div>
        <strong>Workspace setup is incomplete</strong>
        <p>
          {!configuration.setup.githubReady
            ? "GitHub repository access needs to be configured before you can connect your application."
            : "Repository connection is available. Execution needs the remaining service configuration."}
        </p>
      </div>
      <details>
        <summary>Show setup requirements</summary>
        <ul>
          {configuration.setup.missing.map((item) => (
            <li key={item}>
              <code>{item}</code>
            </li>
          ))}
        </ul>
        <p>
          Configure these on the server. No secret values belong in this page.
        </p>
      </details>
    </aside>
  );
}
function AddRepository({
  config,
  busy,
  action,
}: {
  config?: Configuration | undefined;
  busy: boolean;
  action(work: () => Promise<unknown>): Promise<void>;
}) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [query, setQuery] = useState("");
  const [repoId, setRepoId] = useState(0);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    if (config?.connection) {
      setLoading(true);
      void apiJson<{ repositories: Repository[] }>("/api/github/repositories")
        .then((value) => {
          if (live) setRepos(value.repositories);
        })
        .catch((reason) => {
          if (live) setError(reason.message);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }
    return () => {
      live = false;
    };
  }, [config?.connection]);
  useEffect(() => {
    let live = true;
    setBranches([]);
    setBranch("");
    if (repoId)
      void apiJson<{ branches: string[] }>(
        `/api/github/repositories/${repoId}/branches`,
      )
        .then((value) => {
          if (live) {
            setBranches(value.branches);
            setBranch(
              repos.find((repo) => repo.id === repoId)?.defaultBranch ??
                value.branches[0] ??
                "",
            );
          }
        })
        .catch((reason) => {
          if (live) setError(reason.message);
        });
    return () => {
      live = false;
    };
  }, [repoId, repos]);
  return (
    <section>
      <header className="project-page-heading">
        <div>
          <h1>Add repository</h1>
          <p>
            Choose the refund application you want Eigen to integrate and test.
          </p>
        </div>
      </header>
      {error && (
        <p role="alert" className="project-error">
          {error}
        </p>
      )}
      {!config?.connection ? (
        <section className="project-empty">
          <h2>Connect GitHub repository access</h2>
          <p>
            Choose which repositories the Eigen GitHub App can access. Eigen
            uses this permission to read source and open integration and repair
            PRs.
          </p>
          <button
            type="button"
            className="project-primary"
            disabled={busy || !config?.setup.githubReady}
            onClick={() =>
              void action(async () => {
                const value = await post<{ url: string }>(
                  "/api/github/connect",
                  {},
                );
                window.location.assign(value.url);
              })
            }
          >
            Connect GitHub
          </button>
        </section>
      ) : (
        <>
          <div className="project-section-heading">
            <p>
              Connected as <strong>{config.connection.login}</strong>
            </p>
            {config.installationUrl && (
              <a href={config.installationUrl}>
                Manage repository access on GitHub
              </a>
            )}
          </div>
          {loading ? (
            <p role="status">Loading accessible repositories…</p>
          ) : (
            <>
              <label className="project-search">
                Search repositories
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="owner / repository"
                />
              </label>
              {!repos.length && (
                <p>
                  No repositories are available. Use “Manage repository access”
                  to install Eigen for the repositories you want to connect.
                </p>
              )}
              <div
                className="project-repository-list"
                role="radiogroup"
                aria-label="Repository"
              >
                {repos
                  .filter((repo) =>
                    `${repo.owner}/${repo.name}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((repo) => (
                    <label key={repo.id}>
                      <input
                        type="radio"
                        name="repository"
                        checked={repoId === repo.id}
                        onChange={() => setRepoId(repo.id)}
                      />
                      <span>
                        <strong>{repo.name}</strong>
                        <span>
                          {repo.owner} · {repo.private ? "Private" : "Public"}
                        </span>
                      </span>
                    </label>
                  ))}
              </div>
              {repoId > 0 && (
                <label className="project-branch">
                  Branch to track
                  <select
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    disabled={!branches.length}
                  >
                    {branches.map((branch) => (
                      <option key={branch}>{branch}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="project-actions">
                <button
                  type="button"
                  className="project-primary"
                  disabled={busy || !repoId || !branch}
                  onClick={() =>
                    void action(async () => {
                      const value = await post<{ project: { id: string } }>(
                        "/api/projects",
                        { repositoryId: repoId, branch },
                      );
                      go(projectPath(value.project.id));
                    })
                  }
                >
                  {busy
                    ? "Connecting repository…"
                    : "Add repository and start integration"}
                </button>
                <button type="button" onClick={() => go("/projects")}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
function PullRequests({
  detail,
  busy,
  onRun,
}: {
  detail: Detail;
  busy: boolean;
  onRun(id: string): void;
}) {
  return (
    <section className="project-section">
      <h2>Linked pull requests</h2>
      {!detail.pullRequests.length ? (
        <p>
          The integration PR will appear here after the agent publishes its
          changes.
        </p>
      ) : (
        detail.pullRequests.map((pr) => (
          <article className="project-pr" key={pr.id}>
            <header className="project-section-heading">
              <h3>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  #{pr.number} ·{" "}
                  {pr.kind === "integration"
                    ? "Eigen integration"
                    : pr.kind === "repair"
                      ? "Repair proposal"
                      : "Repository PR"}
                </a>
              </h3>
              <span className="project-status">
                {pr.draft ? "Draft · " : ""}
                {pr.status}
              </span>
            </header>
            <p>{pr.summary}</p>
            {pr.reviewStatus && (
              <p>
                Latest GitHub review: {status(pr.reviewStatus)}. Open the PR for
                the full review history.
              </p>
            )}
            <p>
              Base <code>{pr.baseCommit.slice(0, 12)}</code> → candidate{" "}
              <code>{pr.candidateCommit.slice(0, 12)}</code>
            </p>
            <p>
              {pr.verified
                ? pr.kind === "integration"
                  ? "Integration verified. Financial test results are recorded separately."
                  : "Selected unchanged tests passed."
                : "Verification incomplete or stale. Run tests on the current PR commit."}
            </p>
            <details>
              <summary>{pr.changedFiles.length} changed files</summary>
              <ul>
                {pr.changedFiles.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </details>
            <div className="project-actions">
              <a
                className="project-button"
                href={pr.url}
                target="_blank"
                rel="noreferrer"
              >
                View PR
              </a>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRun(pr.id)}
              >
                Run tests on this PR
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
function RunList({ detail }: { detail: Detail }) {
  return !detail.runs.length ? (
    <p>
      No completed evaluations yet. Run the suite once integration is ready.
    </p>
  ) : (
    <div className="project-run-list">
      {[...detail.runs].reverse().map((run) => (
        <a
          key={run.id}
          href={projectPath(detail.project.id, `runs/${run.id}`)}
          onClick={(event) => {
            event.preventDefault();
            go(projectPath(detail.project.id, `runs/${run.id}`));
          }}
        >
          <span
            className={`project-status status-${run.decision === "allow" ? "completed" : "failed"}`}
          >
            {run.passed}/{run.total} passed
          </span>
          <code>{run.commit.slice(0, 12)}</code>
          <span>{run.model}</span>
          <time>{new Date(run.createdAt).toLocaleString()}</time>
        </a>
      ))}
    </div>
  );
}
export function ProjectTests({
  detail,
  templates,
  busy,
  refresh,
  onRun,
}: {
  detail: Detail;
  templates: Scenario[];
  busy: boolean;
  refresh(): void;
  onRun(ids: string[], pullRequestId?: string): void;
}) {
  const [editor, setEditor] = useState<{
    scenario?: Scenario;
    testId?: string;
  } | null>(null);
  const [target, setTarget] = useState("");
  const [savingSuite, setSavingSuite] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [description, setDescription] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(
    detail.suites[0]?.testVersionIds ?? [],
  );
  const latest = detail.tests.filter(
    (test) =>
      selected.includes(test.id) ||
      !detail.tests.some(
        (other) => other.testId === test.testId && other.version > test.version,
      ),
  );
  return (
    <section className="project-section">
      <header className="project-section-heading">
        <div>
          <h2>Tests</h2>
          <p>
            Reviewed scenarios stay unchanged. Custom tests are saved as new
            versions.
          </p>
        </div>
        <button
          type="button"
          className="project-primary"
          disabled={busy || !selected.length}
          onClick={() => onRun(selected, target || undefined)}
        >
          Run {selected.length} selected tests
        </button>
      </header>
      <div className="project-form-grid">
        <label>
          Evaluate source
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Tracked branch · {detail.project.branch}</option>
            {detail.pullRequests
              .filter((pr) => pr.status === "open")
              .map((pr) => (
                <option key={pr.id} value={pr.id}>
                  PR #{pr.number} · {pr.candidateCommit.slice(0, 12)}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || savingSuite || !selected.length}
          onClick={() => {
            const suite = detail.suites[0];
            if (!suite) return;
            setSavingSuite(true);
            setError("");
            void apiJson(
              `/api/projects/${detail.project.id}/suites/${suite.id}`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ testVersionIds: selected }),
              },
            )
              .then(refresh)
              .catch((reason: unknown) =>
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Suite could not be saved.",
                ),
              )
              .finally(() => setSavingSuite(false));
          }}
        >
          {savingSuite ? "Saving suite…" : "Save selection as default suite"}
        </button>
      </div>
      {!editor && (
        <div className="project-actions">
          <button
            type="button"
            onClick={() => {
              setShowTemplates(!showTemplates);
              setDescribing(false);
            }}
          >
            Use template
          </button>
          <button type="button" onClick={() => setEditor({})}>
            Create test
          </button>
          <button
            type="button"
            onClick={() => {
              setDescribing(!describing);
              setShowTemplates(false);
            }}
          >
            Describe a test
          </button>
        </div>
      )}
      {showTemplates && (
        <div className="project-template-list">
          {templates.map((scenario) => (
            <button
              type="button"
              key={scenario.id}
              onClick={() => {
                setEditor({ scenario });
                setShowTemplates(false);
              }}
            >
              {scenario.name}
              <span>Create an editable copy</span>
            </button>
          ))}
        </div>
      )}
      {describing && !editor && (
        <form
          className="project-draft"
          onSubmit={(event) => {
            event.preventDefault();
            setDrafting(true);
            setError("");
            void post<{ scenario: Scenario }>(
              `/api/projects/${detail.project.id}/tests/draft`,
              { description },
            )
              .then((value) => {
                setEditor({ scenario: value.scenario });
                setDescribing(false);
              })
              .catch((reason) => setError(reason.message))
              .finally(() => setDrafting(false));
          }}
        >
          <label>
            Describe the behavior you want to test
            <textarea
              required
              minLength={10}
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="For example: the refund succeeds, but the agent receives a timeout and retries."
            />
          </label>
          <p>
            You will review the generated scenario before saving or running it.
          </p>
          <button disabled={drafting || busy} type="submit">
            {drafting ? "Drafting test…" : "Generate draft"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="project-error">
          {error}
        </p>
      )}
      {editor && (
        <ProjectTestEditor
          key={editor.testId ?? editor.scenario?.id ?? "new-test"}
          projectId={detail.project.id}
          initial={editor.scenario}
          testId={editor.testId}
          onSaved={() => {
            setEditor(null);
            refresh();
          }}
          onCancel={() => setEditor(null)}
        />
      )}
      <div className="project-tests">
        {latest.map((test) => (
          <div className="project-test-row" key={test.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(test.id)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked
                      ? [
                          ...ids.filter(
                            (id) =>
                              detail.tests.find((item) => item.id === id)
                                ?.testId !== test.testId,
                          ),
                          test.id,
                        ]
                      : ids.filter((id) => id !== test.id),
                  )
                }
              />
              <span>
                <strong>{test.scenario.name}</strong>
                <span>
                  {test.source === "reviewed"
                    ? "Reviewed starter"
                    : `Custom · version ${test.version}`}{" "}
                  {detail.tests.some(
                    (other) =>
                      other.testId === test.testId &&
                      other.version > test.version,
                  )
                    ? " · Historical selection"
                    : ""}
                  ·{" "}
                  {test.scenario.task_expectation === "refuse"
                    ? "Refuse request"
                    : "Complete refund"}
                </span>
              </span>
            </label>
            <button
              type="button"
              disabled={Boolean(editor)}
              onClick={() =>
                setEditor({
                  scenario: test.scenario,
                  ...(test.source === "custom" ? { testId: test.testId } : {}),
                })
              }
            >
              {test.source === "reviewed" ? "Create copy" : "Edit test"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
function ProjectSettings({
  detail,
  busy,
  action,
}: {
  detail: Detail;
  busy: boolean;
  action(work: () => Promise<unknown>): Promise<void>;
}) {
  const [branch, setBranch] = useState(detail.project.branch);
  const [automatic, setAutomatic] = useState(detail.project.automaticRuns);
  const [disconnect, setDisconnect] = useState(false);
  return (
    <section className="project-section">
      <h2>Project settings</h2>
      <form
        className="project-settings"
        onSubmit={(event) => {
          event.preventDefault();
          void action(() =>
            apiJson(`/api/projects/${detail.project.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ branch, automaticRuns: automatic }),
            }),
          );
        }}
      >
        <label>
          Tracked branch
          <input
            required
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
        </label>
        <label className="project-check">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(event) => setAutomatic(event.target.checked)}
          />
          Run tests on tracked-branch pushes and same-repository PR updates
        </label>
        <p>
          Automatic runs are limited to 20 per project per day and queued one at
          a time. Fork PRs do not execute.
        </p>
        <label>
          Configured model
          <input readOnly value={detail.project.model} />
        </label>
        <button className="project-primary" disabled={busy} type="submit">
          Save settings
        </button>
      </form>
      <section className="project-disconnect">
        <h3>Disconnect repository</h3>
        <p>
          This stops new jobs and requests cancellation of active jobs. Saved
          evidence remains available.
        </p>
        {!disconnect ? (
          <button type="button" onClick={() => setDisconnect(true)}>
            Disconnect…
          </button>
        ) : (
          <div className="project-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  apiJson(`/api/projects/${detail.project.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ disconnect: true }),
                  }),
                )
              }
            >
              Confirm disconnect
            </button>
            <button type="button" onClick={() => setDisconnect(false)}>
              Keep connected
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
