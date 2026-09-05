import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
  emailVerified?: boolean;
}

export interface DashboardAuth {
  baseUrl: string;
  verify(token: string): Promise<AuthUser>;
}

export function createDashboardAuth(
  environment: { NEON_AUTH_BASE_URL?: string; NEON_AUTH_JWKS_URL?: string },
  options: { key?: JWTVerifyGetKey; now?: () => Date } = {},
): DashboardAuth | undefined {
  if (environment.NEON_AUTH_BASE_URL === undefined) return undefined;
  const base = new URL(environment.NEON_AUTH_BASE_URL);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "NEON_AUTH_BASE_URL must be an HTTPS URL without credentials or query parameters.",
    );
  const baseUrl = base.href.replace(/\/$/, "");
  const jwksUrl = `${baseUrl}/.well-known/jwks.json`;
  if (
    environment.NEON_AUTH_JWKS_URL &&
    environment.NEON_AUTH_JWKS_URL !== jwksUrl
  )
    throw new Error(
      "NEON_AUTH_JWKS_URL must belong to the configured Neon Auth branch.",
    );
  const key =
    options.key ??
    createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 5000 });
  return {
    baseUrl,
    async verify(token) {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["EdDSA"],
        issuer: base.origin,
        audience: base.origin,
        requiredClaims: ["sub", "exp", "iat"],
        currentDate: (options.now ?? (() => new Date()))(),
      });
      if (
        !payload.sub ||
        payload.role !== "authenticated" ||
        payload.banned === true
      )
        throw new Error("An active authenticated user is required.");
      return {
        id: payload.sub,
        name: typeof payload.name === "string" ? payload.name : "Eigen user",
        email: typeof payload.email === "string" ? payload.email : null,
        ...(payload.emailVerified === true || payload.email_verified === true
          ? { emailVerified: true }
          : {}),
      };
    },
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** Local workspace authentication. Project-level authorization belongs to the hosted service. */
export function withDashboardAuth(
  api: (request: Request, user?: AuthUser) => Promise<Response | undefined>,
  auth: DashboardAuth | undefined,
) {
  return async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/config" && request.method === "GET")
      return json(
        auth ? { enabled: true, baseUrl: auth.baseUrl } : { enabled: false },
      );
    if (!path.startsWith("/api/")) return api(request);
    if (!auth) return api(request);
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer ([^\s]+)$/i.exec(header);
    if (!match?.[1] || match[1].length > 16384)
      return json({ error: "Sign in to access this workspace." }, 401);
    let user: AuthUser;
    try {
      user = await auth.verify(match[1]);
    } catch {
      return json(
        { error: "Your session could not be verified. Sign in again." },
        401,
      );
    }
    if (path === "/api/auth/session" && request.method === "GET")
      return json({ user });
    return api(request, user);
  };
}
