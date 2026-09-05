import { randomUUID } from "node:crypto";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { Pool } from "pg";
import type { AuthUser, DashboardAuth } from "./auth.js";

export const hostedAuthPath = "/api/auth/login";

export function hostedAuthOptions(
  env: NodeJS.ProcessEnv,
  database: BetterAuthOptions["database"],
  generateId: () => string = randomUUID,
): BetterAuthOptions {
  const origin = new URL(env.EIGEN_PUBLIC_ORIGIN ?? "").origin;
  if (
    !origin.startsWith("https://") ||
    !env.GITHUB_OAUTH_CLIENT_ID ||
    !env.GITHUB_OAUTH_CLIENT_SECRET ||
    !env.EIGEN_AUTH_SECRET ||
    env.EIGEN_AUTH_SECRET.length < 32
  )
    throw new Error("Hosted GitHub sign-in configuration is incomplete.");
  const invited = (env.EIGEN_INVITED_USERS ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
  return {
    appName: "Eigen",
    baseURL: origin,
    basePath: hostedAuthPath,
    secret: env.EIGEN_AUTH_SECRET,
    database,
    trustedOrigins: [origin],
    socialProviders: {
      github: {
        clientId: env.GITHUB_OAUTH_CLIENT_ID,
        clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
        scope: ["read:user", "user:email"],
      },
    },
    user: {
      modelName: "eigen_auth_user",
      additionalFields: {
        banned: { type: "boolean", defaultValue: false, input: false },
      },
    },
    session: {
      modelName: "eigen_auth_session",
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "eigen_auth_account",
      storeStateStrategy: "database",
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    verification: { modelName: "eigen_auth_verification" },
    advanced: {
      cookiePrefix: "eigen-auth",
      useSecureCookies: true,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      database: { generateId },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) =>
            user.emailVerified && invited.includes(user.email.toLowerCase())
              ? { data: user }
              : false,
        },
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: { "/sign-in/social": { window: 60, max: 10 } },
    },
    logger: { disabled: true },
    plugins: [bearer()],
  };
}

/** Hosted sessions use Eigen's origin. Neon remains the private database. */
export function createHostedDashboardAuth(
  env: NodeJS.ProcessEnv,
  options: {
    database?: BetterAuthOptions["database"];
    generateId?: () => string;
  } = {},
): DashboardAuth {
  if (!options.database && !env.DATABASE_URL)
    throw new Error("Hosted authentication requires DATABASE_URL.");
  const pool = options.database
    ? undefined
    : new Pool({
        connectionString: env.DATABASE_URL,
        max: 4,
        connectionTimeoutMillis: 10_000,
      });
  const config = hostedAuthOptions(
    env,
    options.database ?? pool,
    options.generateId,
  );
  const auth = betterAuth(config);
  const origin = new URL(env.EIGEN_PUBLIC_ORIGIN ?? "").origin;
  const routes: Record<string, string> = {
    "/get-session": "GET",
    "/sign-in/social": "POST",
    "/callback/github": "GET",
    "/sign-out": "POST",
  };
  return {
    mode: "github",
    baseUrl: `${origin}${hostedAuthPath}`,
    async handle(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${hostedAuthPath}/`)) return undefined;
      const path = url.pathname.slice(hostedAuthPath.length);
      if (path === "/error" && request.method === "GET")
        return new Response(null, {
          status: 303,
          headers: {
            Location: `${origin}/?signin_error=1`,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          },
        });
      if (!routes[path] || routes[path] !== request.method)
        return Response.json(
          { error: "Auth route not found." },
          { status: 404 },
        );
      if (
        request.method === "POST" &&
        (request.headers.get("origin") !== origin ||
          !request.headers.get("content-type")?.startsWith("application/json"))
      )
        return Response.json(
          { error: "Invalid sign-in request origin." },
          { status: 403 },
        );
      const response = await auth.handler(request);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      return response;
    },
    async verify(token): Promise<AuthUser> {
      const result = await auth.api.getSession({
        headers: new Headers({ authorization: `Bearer ${token}` }),
      });
      if (
        !result?.user ||
        !result.session ||
        ("banned" in result.user && result.user.banned === true)
      )
        throw new Error("An active authenticated user is required.");
      return {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        emailVerified: result.user.emailVerified,
      };
    },
    async close() {
      await pool?.end();
    },
  };
}
