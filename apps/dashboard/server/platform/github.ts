import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { safeRepoPath } from "./security.js";
import { PlatformError, type Repository } from "./types.js";

export interface GitHubConfig {
  appId: string;
  slug: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  origin: string;
}
export interface GitHubToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}
export interface SourceSnapshot {
  commit: string;
  files: Record<string, string>;
}
export interface GitHubProvider {
  authorizeUrl(state: string, challenge: string): string;
  installationUrl(): string;
  exchange(code: string, verifier: string): Promise<GitHubToken>;
  refresh(token: string): Promise<GitHubToken>;
  user(token: string): Promise<{ id: number; login: string }>;
  repositories(token: string): Promise<Repository[]>;
  branches(token: string, repo: Repository): Promise<string[]>;
  resolve(repo: Repository, ref: string): Promise<string>;
  snapshot(repo: Repository, commit: string): Promise<SourceSnapshot>;
  publish(
    repo: Repository,
    input: {
      branch: string;
      baseBranch: string;
      baseCommit: string;
      files: Record<string, string>;
      title: string;
      body: string;
      draft: boolean;
    },
  ): Promise<{
    number: number;
    url: string;
    commit: string;
    status?: "open" | "closed" | "merged";
    draft?: boolean;
  }>;
  check(
    repo: Repository,
    commit: string,
    conclusion: "success" | "failure" | "neutral",
    detailsUrl: string,
    summary: string,
  ): Promise<void>;
}

export function createGitHubProvider(
  config: GitHubConfig,
  fetcher: typeof fetch = fetch,
  now = () => new Date(),
): GitHubProvider {
  const path = (repo: Repository) =>
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  async function api<T>(
    route: string,
    token: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetcher(`https://api.github.com${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new PlatformError(
        response.status === 401 ||
          response.status === 403 ||
          response.status === 404
          ? 409
          : 502,
        "GitHub access is unavailable. Reconnect the repository or check the installation permissions.",
      );
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
  async function installationToken(repo: Repository) {
    const key = await importPKCS8(
      createPrivateKey(config.privateKey.replace(/\\n/g, "\n"))
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      "RS256",
    );
    const at = Math.floor(now().getTime() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(config.appId)
      .setIssuedAt(at - 60)
      .setExpirationTime(at + 540)
      .sign(key);
    return (
      await api<{ token: string }>(
        `/app/installations/${repo.installationId}/access_tokens`,
        jwt,
        "POST",
        { repository_ids: [repo.id] },
      )
    ).token;
  }
  async function tokenRequest(body: Record<string, string>) {
    const response = await fetcher(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          ...body,
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
    const value = (await response.json()) as GitHubToken & { error?: string };
    if (!response.ok || value.error || !value.access_token)
      throw new PlatformError(
        409,
        "GitHub authorization could not be completed. Connect GitHub again.",
      );
    return value;
  }
  return {
    authorizeUrl(state, challenge) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${config.origin}/api/github/callback`,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return url.href;
    },
    installationUrl: () =>
      `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`,
    exchange: (code, verifier) =>
      tokenRequest({
        code,
        code_verifier: verifier,
        redirect_uri: `${config.origin}/api/github/callback`,
      }),
    refresh: (token) =>
      tokenRequest({ grant_type: "refresh_token", refresh_token: token }),
    user: (token) => api("/user", token),
    async repositories(token) {
      const repos: Repository[] = [];
      for (let page = 1; page <= 10; page++) {
        const value = await api<{
          installations: {
            id: number;
            app_id: number;
            suspended_at: string | null;
          }[];
        }>(`/user/installations?per_page=100&page=${page}`, token);
        for (const install of value.installations.filter(
          (item) => !item.suspended_at && String(item.app_id) === config.appId,
        )) {
          for (let repoPage = 1; repoPage <= 20; repoPage++) {
            const data = await api<{
              repositories: {
                id: number;
                owner: { login: string };
                name: string;
                default_branch: string;
                private: boolean;
                archived: boolean;
                permissions?: { push?: boolean };
              }[];
            }>(
              `/user/installations/${install.id}/repositories?per_page=100&page=${repoPage}`,
              token,
            );
            repos.push(
              ...data.repositories
                .filter(
                  (item) => !item.archived && item.permissions?.push === true,
                )
                .map((item) => ({
                  id: item.id,
                  installationId: install.id,
                  owner: item.owner.login,
                  name: item.name,
                  defaultBranch: item.default_branch,
                  private: item.private,
                })),
            );
            if (data.repositories.length < 100) break;
          }
        }
        if (value.installations.length < 100) break;
      }
      return repos;
    },
    async branches(token, repo) {
      return (
        await api<{ name: string }[]>(
          `${path(repo)}/branches?per_page=100`,
          token,
        )
      ).map((item) => item.name);
    },
    async resolve(repo, ref) {
      const token = await installationToken(repo);
      return (
        await api<{ sha: string }>(
          `${path(repo)}/commits/${encodeURIComponent(ref)}`,
          token,
        )
      ).sha;
    },
    async snapshot(repo, commit) {
      if (!/^[a-f0-9]{40}$/.test(commit))
        throw new PlatformError(400, "A resolved commit is required.");
      const token = await installationToken(repo);
      const tree = await api<{
        truncated: boolean;
        tree: {
          path: string;
          type: string;
          mode: string;
          sha: string;
          size?: number;
        }[];
      }>(`${path(repo)}/git/trees/${commit}?recursive=1`, token);
      const entries = tree.tree.filter(
        (item) =>
          item.type === "blob" &&
          !item.path.startsWith(".github/workflows/") &&
          !item.path.split("/").some((part) => part.startsWith(".env")),
      );
      if (tree.truncated || entries.length > 1500)
        throw new PlatformError(
          422,
          "This repository exceeds the pilot's 1,500-file limit.",
        );
      const files: Record<string, string> = {};
      let bytes = 0;
      for (const entry of entries) {
        if (entry.mode === "120000")
          throw new PlatformError(
            422,
            "Repositories with symbolic links need configuration before evaluation.",
          );
        if (
          !/\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|lock|toml)$/.test(entry.path) &&
          ![".gitignore", ".npmrc"].includes(entry.path)
        )
          continue;
        safeRepoPath(entry.path);
        bytes += entry.size ?? 0;
        if (bytes > 20_000_000 || (entry.size ?? 0) > 2_000_000)
          throw new PlatformError(
            422,
            "Repository source exceeds the pilot's size limit.",
          );
        const blob = await api<{ content: string }>(
          `${path(repo)}/git/blobs/${entry.sha}`,
          token,
        );
        const content = Buffer.from(blob.content, "base64").toString("utf8");
        if (
          entry.path === ".npmrc" &&
          /(_auth|token|password|registry\s*=)/i.test(content)
        )
          throw new PlatformError(
            422,
            "Private package configuration needs a supported public-dependency setup.",
          );
        files[entry.path] = content;
      }
      if (!files["package.json"])
        throw new PlatformError(
          422,
          "The pilot requires a JavaScript or TypeScript package at the repository root.",
        );
      return { commit, files };
    },
    async publish(repo, input) {
      const token = await installationToken(repo);
      const root = path(repo);
      // Recover a publication after a process interruption without creating another PR.
      const existing = await api<
        {
          number: number;
          html_url: string;
          head: { sha: string };
          state: string;
          merged_at: string | null;
          draft: boolean;
        }[]
      >(
        `${root}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${input.branch}`)}`,
        token,
      );
      const base = await api<{ tree: { sha: string } }>(
        `${root}/git/commits/${input.baseCommit}`,
        token,
      );
      const tree = await api<{ sha: string }>(
        `${root}/git/trees`,
        token,
        "POST",
        {
          base_tree: base.tree.sha,
          tree: Object.entries(input.files).map(([file, content]) => ({
            path: safeRepoPath(file),
            mode: "100644",
            type: "blob",
            content,
          })),
        },
      );
      if (existing[0]) {
        const published = await api<{
          tree: { sha: string };
          parents: { sha: string }[];
        }>(`${root}/git/commits/${existing[0].head.sha}`, token);
        if (
          published.tree.sha !== tree.sha ||
          published.parents[0]?.sha !== input.baseCommit
        )
          throw new PlatformError(
            409,
            "The published agent branch changed. Its current commit does not match the verified candidate. Start a new job.",
          );
        return {
          number: existing[0].number,
          url: existing[0].html_url,
          commit: existing[0].head.sha,
          status: existing[0].merged_at
            ? "merged"
            : existing[0].state === "closed"
              ? "closed"
              : "open",
          draft: existing[0].draft,
        };
      }
      const commit = await api<{ sha: string }>(
        `${root}/git/commits`,
        token,
        "POST",
        { message: input.title, tree: tree.sha, parents: [input.baseCommit] },
      );
      // A deterministic branch can already exist if the previous attempt stopped before opening the PR.
      const refs = await api<{ ref: string; object: { sha: string } }[]>(
        `${root}/git/matching-refs/heads/${encodeURIComponent(input.branch)}`,
        token,
      );
      const prior = refs.find(
        (item) => item.ref === `refs/heads/${input.branch}`,
      );
      if (prior && prior.object.sha !== commit.sha) {
        const priorCommit = await api<{ tree: { sha: string } }>(
          `${root}/git/commits/${prior.object.sha}`,
          token,
        );
        if (priorCommit.tree.sha !== tree.sha)
          throw new PlatformError(
            409,
            "The agent branch changed on GitHub. Start a new job to avoid replacing someone else's work.",
          );
      }
      if (!prior)
        await api(`${root}/git/refs`, token, "POST", {
          ref: `refs/heads/${input.branch}`,
          sha: commit.sha,
        });
      const pr = await api<{
        number: number;
        html_url: string;
        head: { sha: string };
      }>(`${root}/pulls`, token, "POST", {
        title: input.title,
        body: input.body,
        head: input.branch,
        base: input.baseBranch,
        draft: input.draft,
      });
      return { number: pr.number, url: pr.html_url, commit: pr.head.sha };
    },
    async check(repo, commit, conclusion, detailsUrl, summary) {
      const token = await installationToken(repo);
      await api(`${path(repo)}/check-runs`, token, "POST", {
        name: "Eigen refund evaluation",
        head_sha: commit,
        status: "completed",
        conclusion,
        details_url: detailsUrl,
        output: {
          title:
            conclusion === "success"
              ? "Selected tests passed"
              : "Evaluation requires attention",
          summary,
        },
      });
    },
  };
}
