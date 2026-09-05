// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticationHeaders,
  loadAuthentication,
  setAuthTokenSource,
} from "./auth";

// Exercise the real Neon SDK, including its OAuth verifier and session cache.
const baseUrl = "https://eigen-auth.example.test/neondb/auth";
const jwt = `eyJhbGciOiJFZERTQSJ9.${btoa(JSON.stringify({ exp: 4102444800 }))}.signature`;
const session = {
  session: {
    id: "session-one",
    userId: "user-one",
    token: "opaque-cookie-token",
    expiresAt: "2100-01-01T00:00:00.000Z",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  },
  user: {
    id: "user-one",
    name: "Developer",
    email: "developer@example.test",
    emailVerified: true,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  },
};
let sessionResponse: () => Response;
let requests: { url: string; init: RequestInit | undefined }[];
beforeEach(() => {
  requests = [];
  window.history.replaceState(null, "", "/?neon_auth_session_verifier=one");
  sessionResponse = () =>
    Response.json(session, { headers: { "set-auth-jwt": jwt } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      requests.push({ url, init });
      if (url === "/api/auth/config")
        return Response.json({ enabled: true, baseUrl });
      if (url.includes("/get-session")) return sessionResponse();
      if (url.endsWith("/sign-out")) return Response.json({ success: true });
      if (url.endsWith("/sign-in/social"))
        return Response.json({ redirect: false });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});
afterEach(async () => {
  const client = await loadAuthentication();
  await client?.signOut();
  setAuthTokenSource(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Neon session transport", () => {
  it("reuses the callback session JWT without making a separate cookie-dependent token request", async () => {
    const client = await loadAuthentication();
    expect(await client?.hasSession()).toBe(true);
    setAuthTokenSource(client?.token);
    expect(await authenticationHeaders()).toEqual({
      Authorization: `Bearer ${jwt}`,
    });
    expect(
      requests.filter(({ url }) => url.includes("/get-session")),
    ).toHaveLength(1);
    expect(requests.some(({ url }) => url.endsWith("/token"))).toBe(false);
    expect(
      requests.find(({ url }) => url.includes("/get-session"))?.init
        ?.credentials,
    ).toBe("include");
  });
  it("rejects a missing session instead of supplying an anonymous credential", async () => {
    sessionResponse = () => Response.json(null);
    const client = await loadAuthentication();
    expect(await client?.hasSession()).toBe(false);
    await expect(client?.token()).rejects.toThrow("session expired");
  });
  it("refreshes an expired SDK cache through getSession before supplying the next API token", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1788600000000);
    const expiring = `eyJhbGciOiJFZERTQSJ9.${btoa(JSON.stringify({ exp: 1788600900 }))}.old`;
    sessionResponse = () =>
      Response.json(session, { headers: { "set-auth-jwt": expiring } });
    const client = await loadAuthentication();
    expect(await client?.token()).toBe(expiring);
    clock.mockReturnValue(1788601000000);
    sessionResponse = () =>
      Response.json(session, { headers: { "set-auth-jwt": jwt } });
    expect(await client?.token()).toBe(jwt);
    expect(
      requests.filter(({ url }) => url.includes("/get-session")),
    ).toHaveLength(2);
  });
  it("does not reuse the cached JWT after sign-out", async () => {
    const client = await loadAuthentication();
    expect(await client?.token()).toBe(jwt);
    await client?.signOut();
    sessionResponse = () => Response.json(null);
    await expect(client?.token()).rejects.toThrow("session expired");
  });
  it("never forwards an opaque session cookie as an API JWT", async () => {
    sessionResponse = () => Response.json(session);
    const client = await loadAuthentication();
    await expect(client?.token()).rejects.toThrow("API session token");
  });
  it("distinguishes a provider failure from an expired session", async () => {
    sessionResponse = () =>
      Response.json({ message: "Unavailable" }, { status: 503 });
    const client = await loadAuthentication();
    await expect(client?.token()).rejects.not.toThrow("session expired");
  });
});
