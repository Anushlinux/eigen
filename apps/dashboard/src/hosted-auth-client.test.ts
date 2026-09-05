// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  authenticationHeaders,
  loadAuthentication,
  setAuthTokenSource,
} from "./auth";

afterEach(() => {
  setAuthTokenSource(undefined);
  vi.unstubAllGlobals();
});

it("keeps session refresh and sign-out on Eigen's origin without contacting Neon", async () => {
  const baseUrl = `${window.location.origin}/api/auth/login`;
  let signedIn = true;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push(input);
      if (input === "/api/auth/config")
        return Response.json({ enabled: true, mode: "github", baseUrl });
      expect(new URL(input).origin).toBe(window.location.origin);
      expect(init?.credentials).toBe("same-origin");
      if (input.endsWith("/sign-out")) {
        signedIn = false;
        return Response.json({ success: true });
      }
      return Response.json(
        signedIn
          ? {
              user: { id: "preserved-user" },
              session: { token: "opaque-durable-session" },
            }
          : null,
      );
    }),
  );
  const auth = await loadAuthentication();
  expect(await auth?.hasSession()).toBe(true);
  setAuthTokenSource(auth?.token);
  expect(await authenticationHeaders()).toEqual({
    Authorization: "Bearer opaque-durable-session",
  });
  await auth?.signOut();
  expect(await auth?.hasSession()).toBe(false);
  await expect(auth?.token()).rejects.toThrow("session expired");
  expect(
    calls.every((url) => url === "/api/auth/config" || url.startsWith(baseUrl)),
  ).toBe(true);
});

it("rejects an external hosted-auth address and distinguishes service failure from no session", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        enabled: true,
        mode: "github",
        baseUrl: "https://attacker.test/api/auth/login",
      }),
    ),
  );
  await expect(loadAuthentication()).rejects.toThrow("Invalid hosted sign-in");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/auth/config"
        ? Response.json({
            enabled: true,
            mode: "github",
            baseUrl: `${window.location.origin}/api/auth/login`,
          })
        : Response.json({ error: "Unavailable" }, { status: 503 }),
    ),
  );
  const auth = await loadAuthentication();
  await expect(auth?.hasSession()).rejects.toThrow(
    "Sign-in could not complete",
  );
});
