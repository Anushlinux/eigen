import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getMigrations } from "better-auth/db/migration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDashboardAuth } from "./auth.js";
import { createHostedDashboardAuth, hostedAuthOptions } from "./hosted-auth.js";

const origin = "https://eigen.example.test";
const base = `${origin}/api/auth/login`;
const env = {
  EIGEN_PUBLIC_ORIGIN: origin,
  EIGEN_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
  GITHUB_OAUTH_CLIENT_ID: "github-client",
  GITHUB_OAUTH_CLIENT_SECRET: "github-secret",
  EIGEN_INVITED_USERS: "existing-neon-user",
};
let db: DatabaseSync;
let auth: ReturnType<typeof createHostedDashboardAuth>;
let upstream: string[];
let codeChallenge: string;
const cookies = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const request = (path: string, options: RequestInit = {}) =>
  new Request(`${base}${path}`, options);
async function start() {
  const response = await auth.handle?.(
    request("/sign-in/social", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: `${origin}/projects`,
        errorCallbackURL: `${origin}/?signin_error=1`,
        disableRedirect: true,
      }),
    }),
  );
  expect(response?.status).toBe(200);
  if (!response) throw new Error("Missing sign-in response");
  const url = new URL((await response.json()).url);
  codeChallenge = url.searchParams.get("code_challenge") ?? "";
  return { url, cookie: cookies(response as Response) };
}
async function signIn() {
  const started = await start();
  const response = await auth.handle?.(
    request(
      `/callback/github?code=one-time-code&state=${started.url.searchParams.get("state")}`,
      { headers: { Cookie: started.cookie } },
    ),
  );
  expect(response?.status).toBe(302);
  expect(response?.headers.get("location")).toBe(`${origin}/projects`);
  const cookie = cookies(response as Response);
  const session = await auth.handle?.(
    request("/get-session", { headers: { Cookie: cookie } }),
  );
  return { cookie, session: await session?.json(), started };
}
beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  await (await getMigrations(hostedAuthOptions(env, db))).runMigrations();
  const now = Date.now();
  db.prepare(
    "INSERT INTO eigen_auth_user (id,name,email,emailVerified,createdAt,updatedAt,banned) VALUES (?,?,?,?,?,?,?)",
  ).run("existing-neon-user", "Developer", "dev@example.test", 1, now, now, 0);
  db.prepare(
    "INSERT INTO eigen_auth_account (id,accountId,providerId,userId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
  ).run(
    "existing-github-link",
    "123",
    "github",
    "existing-neon-user",
    now,
    now,
  );
  auth = createHostedDashboardAuth(env, { database: db });
  upstream = [];
  codeChallenge = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      upstream.push(url);
      if (url === "https://github.com/login/oauth/access_token") {
        const body = new URLSearchParams(init?.body as string);
        expect(body.get("redirect_uri")).toBe(`${base}/callback/github`);
        expect(
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(codeChallenge);
        return Response.json({
          access_token: "test-provider-token",
          token_type: "bearer",
          scope: "read:user,user:email",
        });
      }
      if (url === "https://api.github.com/user")
        return Response.json({
          id: 123,
          login: "developer",
          name: "Developer",
          email: "dev@example.test",
          avatar_url: null,
        });
      if (url === "https://api.github.com/user/emails")
        return Response.json([
          { email: "dev@example.test", primary: true, verified: true },
        ]);
      throw new Error(`Unexpected auth destination: ${url}`);
    }),
  );
});
afterEach(async () => {
  await auth.close?.();
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("hosted GitHub authentication", () => {
  it("does not import provider secrets into public auth configuration", async () => {
    const api = withDashboardAuth(async () => undefined, auth);
    const response = await api(new Request(`${origin}/api/auth/config`));
    expect(await response?.json()).toEqual({
      enabled: true,
      mode: "github",
      baseUrl: base,
    });
  });
  it("keeps the complete OAuth round trip on GitHub and Eigen with PKCE and a secure browser state cookie", async () => {
    const { url, cookie } = await start();
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${base}/callback/github`,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(codeChallenge).toHaveLength(43);
    expect(cookie).toContain("__Secure-eigen-auth.state=");
    expect(upstream).toEqual([]);
  });
  it("preserves the imported Neon user ID, verifies durable sessions, and revokes the API token on sign-out", async () => {
    const { session, cookie } = await signIn();
    expect(session.user.id).toBe("existing-neon-user");
    expect(await auth.verify(session.session.token)).toMatchObject({
      id: "existing-neon-user",
      emailVerified: true,
    });
    const recreated = createHostedDashboardAuth(env, { database: db });
    expect(await recreated.verify(session.session.token)).toMatchObject({
      id: "existing-neon-user",
    });
    const api = withDashboardAuth(
      async () => Response.json({ owned: true }),
      auth,
    );
    expect(
      (
        await api(
          new Request(`${origin}/api/projects`, {
            headers: { Authorization: `Bearer ${session.session.token}` },
          }),
        )
      )?.status,
    ).toBe(200);
    await auth.handle?.(
      request("/sign-out", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    await expect(auth.verify(session.session.token)).rejects.toThrow();
    expect(
      upstream.every((url) => new URL(url).hostname.endsWith("github.com")),
    ).toBe(true);
  });
  it("rejects callbacks from another browser and callbacks without state before exchanging a code", async () => {
    const { url } = await start();
    for (const path of [
      `/callback/github?code=unused&state=${url.searchParams.get("state")}`,
      "/callback/github?code=unused",
    ]) {
      const r = await auth.handle?.(request(path));
      expect(r?.headers.get("set-cookie") ?? "").not.toContain(
        "session_token=",
      );
    }
    expect(upstream).toEqual([]);
  });
  it("consumes OAuth state once and rejects expired state", async () => {
    const { started } = await signIn();
    const count = upstream.length;
    await auth.handle?.(
      request(
        `/callback/github?code=unused&state=${started.url.searchParams.get("state")}`,
        { headers: { Cookie: started.cookie } },
      ),
    );
    expect(upstream).toHaveLength(count);
    const expired = await start();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await auth.handle?.(
      request(
        `/callback/github?code=unused&state=${expired.url.searchParams.get("state")}`,
        { headers: { Cookie: expired.cookie } },
      ),
    );
    expect(upstream).toHaveLength(count);
  });
  it("rejects forged tokens, expired sessions, and banned users", async () => {
    const { session } = await signIn();
    await expect(auth.verify("forged-token")).rejects.toThrow();
    db.prepare("UPDATE eigen_auth_user SET banned=1 WHERE id=?").run(
      "existing-neon-user",
    );
    await expect(auth.verify(session.session.token)).rejects.toThrow();
    db.prepare("UPDATE eigen_auth_user SET banned=0 WHERE id=?").run(
      "existing-neon-user",
    );
    db.prepare("UPDATE eigen_auth_session SET expiresAt=?").run(
      Date.now() - 1000,
    );
    await expect(auth.verify(session.session.token)).rejects.toThrow();
  });
  it("blocks cross-site mutations and unused auth endpoints", async () => {
    for (const path of ["/sign-in/social", "/sign-out"]) {
      expect(
        (
          await auth.handle?.(
            request(path, {
              method: "POST",
              headers: {
                Origin: "https://attacker.test",
                "Content-Type": "application/json",
              },
              body: "{}",
            }),
          )
        )?.status,
      ).toBe(403);
    }
    expect((await auth.handle?.(request("/list-accounts")))?.status).toBe(404);
    expect(
      (await auth.handle?.(request("/get-session")))?.headers.get(
        "cache-control",
      ),
    ).toBe("no-store");
    expect(upstream).toEqual([]);
  });
  it("does not let an uninvited new GitHub identity create a user", async () => {
    db.prepare("DELETE FROM eigen_auth_account").run();
    db.prepare("DELETE FROM eigen_auth_user").run();
    const started = await start();
    const response = await auth.handle?.(
      request(
        `/callback/github?code=one-time-code&state=${started.url.searchParams.get("state")}`,
        { headers: { Cookie: started.cookie } },
      ),
    );
    expect(response?.headers.get("location")).toContain("signin_error=1");
    expect(
      db.prepare("SELECT count(*) AS count FROM eigen_auth_user").get()?.count,
    ).toBe(0);
  });
});
