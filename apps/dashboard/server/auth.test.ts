import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDashboardAuth, withDashboardAuth } from "./auth.js";

const origin = "https://branch.neon.tech";
const baseUrl = `${origin}/neondb/auth`;
const time = new Date("2026-09-05T12:00:00Z");
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let auth: NonNullable<ReturnType<typeof createDashboardAuth>>;
beforeAll(async () => {
  keys = await generateKeyPair("EdDSA");
  const key = await exportJWK(keys.publicKey);
  const configured = createDashboardAuth(
    { NEON_AUTH_BASE_URL: baseUrl },
    {
      key: createLocalJWKSet({
        keys: [{ ...key, kid: "test-key", alg: "EdDSA" }],
      }),
      now: () => time,
    },
  );
  if (!configured) throw new Error("Test auth configuration is missing.");
  auth = configured;
});
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: "user-one",
    name: "Developer",
    email: "dev@example.test",
    role: "authenticated",
    iss: origin,
    aud: origin,
    iat: time.getTime() / 1000,
    exp: time.getTime() / 1000 + 900,
    ...overrides,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key" })
    .sign(keys.privateKey);
}

describe("local dashboard authentication", () => {
  it("publishes only the public auth URL and guards all report and execution APIs before dispatch", async () => {
    const downstream = vi.fn(async () => new Response("private"));
    const api = withDashboardAuth(downstream, auth);
    const config = await api(
      new Request("http://127.0.0.1:4173/api/auth/config"),
    );
    expect(await config?.json()).toEqual({ enabled: true, baseUrl });
    for (const [path, method] of [
      ["/api/reports", "GET"],
      ["/api/external/jobs", "POST"],
      ["/api/razorpay/smoke", "POST"],
      ["/api/status", "GET"],
    ]) {
      const response = await api(
        new Request(`http://127.0.0.1:4173${path}`, { method }),
      );
      expect(response?.status).toBe(401);
      expect(response?.headers.get("cache-control")).toBe("no-store");
    }
    expect(downstream).not.toHaveBeenCalled();
  });

  it("returns verified identity and permits authenticated API requests", async () => {
    const downstream = vi.fn(async () => new Response("private"));
    const api = withDashboardAuth(downstream, auth);
    const headers = { Authorization: `Bearer ${await token()}` };
    const session = await api(
      new Request("http://localhost/api/auth/session", { headers }),
    );
    expect(await session?.json()).toEqual({
      user: { id: "user-one", name: "Developer", email: "dev@example.test" },
    });
    expect(downstream).not.toHaveBeenCalled();
    expect(
      await (
        await api(new Request("http://localhost/api/reports", { headers }))
      )?.text(),
    ).toBe("private");
    expect(downstream).toHaveBeenCalledOnce();
  });

  it.each([
    { exp: time.getTime() / 1000 - 1 },
    { iss: "https://another-branch.neon.tech" },
    { aud: "another-app" },
    { sub: "" },
    { role: "anonymous" },
    { banned: true },
  ])(
    "rejects invalid claims without calling the protected API: %j",
    async (claims) => {
      const downstream = vi.fn(async () => new Response());
      const response = await withDashboardAuth(
        downstream,
        auth,
      )(
        new Request("http://localhost/api/reports", {
          headers: { Authorization: `Bearer ${await token(claims)}` },
        }),
      );
      expect(response?.status).toBe(401);
      expect(downstream).not.toHaveBeenCalled();
    },
  );

  it("rejects a forged signature, malformed tokens, and key-service failures without revealing details", async () => {
    const parts = (await token()).split(".");
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: "attacker" })).toString("base64url")}.${parts[2]}`;
    const api = withDashboardAuth(vi.fn(), auth);
    for (const value of [forged, "invalid", "x".repeat(16385)]) {
      expect(
        (
          await api(
            new Request("http://localhost/api/reports", {
              headers: { Authorization: `Bearer ${value}` },
            }),
          )
        )?.status,
      ).toBe(401);
    }
    const unavailable = withDashboardAuth(vi.fn(), {
      baseUrl,
      verify: async () => {
        throw new Error("private transport details");
      },
    });
    const response = await unavailable(
      new Request("http://localhost/api/reports", {
        headers: { Authorization: "Bearer fake" },
      }),
    );
    expect(response?.status).toBe(401);
    expect(await response?.text()).not.toContain("private transport details");
  });

  it("retains explicit local compatibility only when Neon is absent; malformed config fails closed", async () => {
    expect(createDashboardAuth({})).toBeUndefined();
    for (const base of [
      "",
      "http://unsafe.test/auth",
      "https://user:password@host.test/auth",
      `${baseUrl}?secret=bad`,
    ])
      expect(() => createDashboardAuth({ NEON_AUTH_BASE_URL: base })).toThrow();
    expect(() =>
      createDashboardAuth({
        NEON_AUTH_BASE_URL: baseUrl,
        NEON_AUTH_JWKS_URL: "https://elsewhere.test/keys",
      }),
    ).toThrow();
    const api = withDashboardAuth(
      async () => new Response("legacy local"),
      undefined,
    );
    expect(
      await (
        await api(new Request("http://localhost/api/auth/config"))
      )?.json(),
    ).toEqual({ enabled: false });
    expect(
      await (await api(new Request("http://localhost/api/reports")))?.text(),
    ).toBe("legacy local");
  });
});
