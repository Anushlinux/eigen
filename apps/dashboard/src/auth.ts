export interface AuthUser {
  id: string;
  name: string;
  email: string | null;
}

let tokenSource: (() => Promise<string>) | undefined;
export const sessionExpiredEvent = "eigen:session-expired";

export function setAuthTokenSource(
  source: (() => Promise<string>) | undefined,
) {
  tokenSource = source;
}

export async function authenticationHeaders(): Promise<Record<string, string>> {
  if (!tokenSource) return {};
  return { Authorization: `Bearer ${await tokenSource()}` };
}

export async function loadAuthentication() {
  const response = await fetch("/api/auth/config", { cache: "no-store" });
  if (!response.ok)
    throw new Error("Sign-in settings could not be loaded. Try again.");
  const config = await response.json();
  if (config.enabled === false) return undefined;
  if (config.enabled !== true || typeof config.baseUrl !== "string")
    throw new Error("The server returned invalid sign-in settings.");
  if (config.mode === "github") return loadHostedAuthentication(config.baseUrl);
  const [{ createAuthClient }, { BetterAuthVanillaAdapter }] =
    await Promise.all([
      import("@neondatabase/auth"),
      import("@neondatabase/auth/vanilla/adapters"),
    ]);
  const client = createAuthClient(config.baseUrl, {
    adapter: BetterAuthVanillaAdapter({
      fetchOptions: { credentials: "include" },
    }),
  });
  return {
    async token() {
      // Neon injects the signed JWT into session.token and refreshes its cache
      // through getSession. The separate /token request cannot reuse the OAuth
      // session verifier when a browser blocks cross-site session cookies.
      const { data, error } = await client.getSession();
      if (error)
        throw new Error("Neon could not check your session. Try again.");
      if (!data?.session || !data.user)
        throw new Error("Your session expired. Sign in again.");
      const token = data.session.token;
      if (token?.split(".").length !== 3)
        throw new Error(
          "Neon did not return an API session token. Sign in again.",
        );
      return token;
    },
    async hasSession() {
      const { data, error } = await client.getSession();
      if (error)
        throw new Error("Neon could not check your session. Try again.");
      return Boolean(data?.session && data?.user);
    },
    async signIn() {
      const { error } = await client.signIn.social({
        provider: "github",
        callbackURL: window.location.origin,
      });
      if (error)
        throw new Error(
          error.message || "GitHub sign-in could not start. Try again.",
        );
    },
    async signOut() {
      const { error } = await client.signOut();
      if (error) throw new Error("Sign-out did not finish. Try again.");
    },
  };
}

async function loadHostedAuthentication(baseUrl: string) {
  const base = new URL(baseUrl, window.location.origin);
  if (
    base.origin !== window.location.origin ||
    base.pathname !== "/api/auth/login"
  )
    throw new Error("Invalid hosted sign-in address.");
  async function call(path: string, body?: unknown) {
    const response = await fetch(`${base.href}${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok)
      throw new Error("Sign-in could not complete. Please try again.");
    return response.json();
  }
  return {
    async hasSession() {
      const value = await call("/get-session");
      return Boolean(value?.session && value?.user);
    },
    async token() {
      const value = await call("/get-session");
      if (!value?.session?.token || !value.user)
        throw new Error("Your session expired. Sign in again.");
      return value.session.token as string;
    },
    async signIn() {
      const value = await call("/sign-in/social", {
        provider: "github",
        callbackURL: `${base.origin}/projects`,
        errorCallbackURL: `${base.origin}/?signin_error=1`,
        disableRedirect: true,
      });
      const target = new URL(value.url);
      if (
        target.origin !== "https://github.com" ||
        target.pathname !== "/login/oauth/authorize"
      )
        throw new Error("GitHub returned an invalid sign-in address.");
      window.location.assign(target.href);
    },
    async signOut() {
      await call("/sign-out", {});
    },
  };
}

export async function verifySession(): Promise<AuthUser> {
  const response = await fetch("/api/auth/session", {
    headers: await authenticationHeaders(),
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error("Your session could not be verified. Sign in again.");
  const value = await response.json();
  return value.user;
}
