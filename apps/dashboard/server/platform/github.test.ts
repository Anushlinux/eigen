import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubProvider } from "./github.js";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const config = {
  appId: "7",
  slug: "eigen",
  privateKey: key,
  clientId: "client",
  clientSecret: "secret",
  origin: "https://eigen.test",
};
const repo = {
  id: 42,
  installationId: 5,
  owner: "owner",
  name: "sample",
  defaultBranch: "main",
  private: true,
};
describe("GitHub App boundary", () => {
  it("lists only the configured App's active installations and repositories writable by the user", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/user/installations")
        return Response.json({
          installations: [
            { id: 5, app_id: 7, suspended_at: null },
            { id: 6, app_id: 999, suspended_at: null },
            { id: 8, app_id: 7, suspended_at: "today" },
          ],
        });
      expect(path).toBe("/user/installations/5/repositories");
      return Response.json({
        repositories: [
          {
            id: 42,
            owner: { login: "owner" },
            name: "sample",
            default_branch: "main",
            private: true,
            archived: false,
            permissions: { push: true },
          },
          {
            id: 43,
            owner: { login: "owner" },
            name: "readonly",
            archived: false,
            permissions: { push: false },
          },
        ],
      });
    });
    expect(
      await createGitHubProvider(config, fetcher).repositories("user-token"),
    ).toEqual([repo]);
  });
  it("accepts GitHub's RSA private-key format and scopes installation credentials to one repository", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("/access_tokens")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            repository_ids: [42],
          });
          expect(new Headers(init?.headers).get("Authorization")).toMatch(
            /^Bearer ey/,
          );
          return Response.json({ token: "installation-token" });
        }
        return Response.json({ sha: "a".repeat(40) });
      },
    );
    expect(
      await createGitHubProvider(config, fetcher).resolve(repo, "main"),
    ).toBe("a".repeat(40));
  });
  it("refuses to attach candidate evidence to a recovered PR whose tree changed", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/access_tokens"))
        return Response.json({ token: "installation-token" });
      if (url.includes("/pulls?"))
        return Response.json([
          {
            number: 3,
            html_url: "https://github.com/owner/sample/pull/3",
            head: { sha: "changed" },
          },
        ]);
      if (url.endsWith("/git/commits/base"))
        return Response.json({ tree: { sha: "base-tree" } });
      if (url.endsWith("/git/trees"))
        return Response.json({ sha: "expected-tree" });
      if (url.endsWith("/git/commits/changed"))
        return Response.json({
          tree: { sha: "different-tree" },
          parents: [{ sha: "base" }],
        });
      throw Error("Unexpected request");
    });
    await expect(
      createGitHubProvider(config, fetcher).publish(repo, {
        baseBranch: "main",
        baseCommit: "base",
        branch: "eigen/integration/job",
        files: { "agent.js": "candidate" },
        title: "Integration",
        body: "Evidence",
        draft: false,
      }),
    ).rejects.toThrow("does not match");
    expect(
      fetcher.mock.calls.some((call) => String(call[0]).endsWith("/pulls")),
    ).toBe(false);
  });
});
