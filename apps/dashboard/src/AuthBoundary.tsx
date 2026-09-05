import { type ReactNode, useEffect, useState } from "react";
import {
  type AuthUser,
  loadAuthentication,
  sessionExpiredEvent,
  setAuthTokenSource,
  verifySession,
} from "./auth";

// Extend Eigen's existing warm-paper workspace with one clear GitHub action.
// Keep loading, errors, and sign-out within the same restrained visual language.
export function AuthBoundary({ children }: { children: ReactNode }) {
  const [auth, setAuth] =
    useState<Awaited<ReturnType<typeof loadAuthentication>>>();
  const [user, setUser] = useState<AuthUser>();
  const [state, setState] = useState<
    "loading" | "local" | "signed-out" | "signed-in" | "error"
  >("loading");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter explicitly reloads remote authentication settings.
  useEffect(() => {
    let active = true;
    setState("loading");
    setError(undefined);
    setAuthTokenSource(undefined);
    void loadAuthentication()
      .then(async (client) => {
        if (!active) return;
        setAuth(client);
        if (!client) {
          setState("local");
          return;
        }
        if (!(await client.hasSession())) {
          if (active) setState("signed-out");
          return;
        }
        if (!active) return;
        setAuthTokenSource(client.token);
        const currentUser = await verifySession();
        if (active) {
          setUser(currentUser);
          setState("signed-in");
        }
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setAuthTokenSource(undefined);
        setError(
          reason instanceof Error
            ? reason.message
            : "Sign-in is unavailable. Try again.",
        );
        setState("error");
      });
    function expired() {
      setAuthTokenSource(undefined);
      setUser(undefined);
      setState("signed-out");
      setError("Your session expired. Sign in again to continue.");
    }
    window.addEventListener(sessionExpiredEvent, expired);
    return () => {
      active = false;
      window.removeEventListener(sessionExpiredEvent, expired);
    };
  }, [attempt]);

  async function signIn() {
    setBusy(true);
    setError(undefined);
    try {
      await auth?.signIn();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "GitHub sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError(undefined);
    try {
      await auth?.signOut();
      setAuthTokenSource(undefined);
      setUser(undefined);
      setState("signed-out");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Sign-out failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (state === "local") return children;
  if (state === "signed-in" && user)
    return (
      <>
        <div className="auth-session-bar">
          <span>
            Signed in as <strong>{user.name}</strong>
          </span>
          <button type="button" disabled={busy} onClick={() => void signOut()}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
        {children}
      </>
    );
  return (
    <main className="auth-page">
      <a className="wordmark" href="/" aria-label="Eigen home">
        EIGEN
      </a>
      <section className="auth-entry" aria-labelledby="auth-title">
        <h1 id="auth-title">Sign in to Eigen</h1>
        <p>
          Connect your repository, review agent changes, and run payment-agent
          evaluations.
        </p>
        {state === "loading" ? (
          <p role="status">Checking your session…</p>
        ) : (
          <>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            {auth && (
              <button
                className="auth-sign-in"
                type="button"
                disabled={busy}
                onClick={() => void signIn()}
              >
                {busy ? "Opening GitHub…" : "Continue with GitHub"}
              </button>
            )}
            {state === "error" && (
              <button
                type="button"
                className="auth-retry"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Try again
              </button>
            )}
            <p className="auth-note">
              Signing in identifies you. Repository access is connected
              separately.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
