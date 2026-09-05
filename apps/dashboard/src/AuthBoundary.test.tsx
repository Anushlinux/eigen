// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  setToken: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("./auth", () => ({
  loadAuthentication: mocks.load,
  setAuthTokenSource: mocks.setToken,
  verifySession: mocks.verify,
  sessionExpiredEvent: "eigen:session-expired",
}));

import { AuthBoundary } from "./AuthBoundary";

const client = {
  hasSession: vi.fn(),
  token: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.load.mockResolvedValue(client);
  client.hasSession.mockResolvedValue(false);
  client.signIn.mockResolvedValue(undefined);
  client.signOut.mockResolvedValue(undefined);
  mocks.verify.mockResolvedValue({ id: "one", name: "Developer", email: null });
});
afterEach(cleanup);
const mount = () =>
  render(
    <AuthBoundary>
      <div>Private reports</div>
    </AuthBoundary>,
  );

describe("GitHub sign-in boundary", () => {
  it("does not mount private content while checking or signed out, and starts GitHub on demand", async () => {
    mount();
    expect(screen.queryByText("Private reports")).toBeNull();
    const button = await screen.findByRole("button", {
      name: "Continue with GitHub",
    });
    expect(screen.queryByText("Private reports")).toBeNull();
    await userEvent.click(button);
    expect(client.signIn).toHaveBeenCalledOnce();
  });
  it("unmounts private reports and clears the API token source after sign-out", async () => {
    client.hasSession.mockResolvedValue(true);
    mount();
    await screen.findByText("Private reports");
    expect(mocks.setToken).toHaveBeenCalledWith(client.token);
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Continue with GitHub" });
    expect(screen.queryByText("Private reports")).toBeNull();
    expect(mocks.setToken).toHaveBeenLastCalledWith(undefined);
  });
  it("shows recoverable provider and configuration errors without exposing private content", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Sign-in settings unavailable"));
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "unavailable",
    );
    expect(screen.queryByText("Private reports")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    client.signIn.mockRejectedValueOnce(
      new Error("GitHub provider is not configured"),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Continue with GitHub" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not configured",
    );
  });
  it("requires backend verification even when Neon reports a session", async () => {
    client.hasSession.mockResolvedValue(true);
    mocks.verify.mockRejectedValueOnce(new Error("Session rejected"));
    mount();
    await screen.findByRole("alert");
    expect(screen.queryByText("Private reports")).toBeNull();
    expect(mocks.setToken).toHaveBeenLastCalledWith(undefined);
  });
  it("removes private content when an API request reports an expired session", async () => {
    client.hasSession.mockResolvedValue(true);
    mount();
    await screen.findByText("Private reports");
    act(() => window.dispatchEvent(new Event("eigen:session-expired")));
    await screen.findByRole("button", { name: "Continue with GitHub" });
    expect(screen.queryByText("Private reports")).toBeNull();
  });
  it("keeps the legacy local dashboard available when authentication is explicitly unconfigured", async () => {
    mocks.load.mockResolvedValue(undefined);
    mount();
    await waitFor(() =>
      expect(screen.getByText("Private reports")).toBeTruthy(),
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
