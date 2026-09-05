// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsApp } from "./ProjectsApp";
import { ProjectTestEditor, parseCurrencyInput } from "./ProjectTestEditor";

const request = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ apiJson: request }));
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/projects");
});
describe("repository project workspace", () => {
  it("starts with projects and explains missing execution setup without showing local reports", async () => {
    request.mockResolvedValue({
      setup: {
        ready: false,
        githubReady: false,
        workerReady: false,
        missing: ["DATABASE_URL", "E2B_API_KEY"],
      },
      connection: null,
      installationUrl: null,
      templates: [],
    });
    render(<ProjectsApp />);
    await screen.findByRole("heading", { name: "Projects" });
    expect(await screen.findByText(/E2B_API_KEY/)).toBeTruthy();
    expect(request).toHaveBeenCalledWith("/api/platform/config");
    expect(request).not.toHaveBeenCalledWith("/api/runs");
  });
  it("persists money in integer subunits only after the user saves the editable draft", async () => {
    request.mockResolvedValue({});
    const saved = vi.fn();
    render(
      <ProjectTestEditor
        projectId="owned"
        onSaved={saved}
        onCancel={vi.fn()}
      />,
    );
    expect(request).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("Test name"), "A small refund");
    await userEvent.click(screen.getByRole("button", { name: /Save test/ }));
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(request.mock.calls[0]?.[1].body);
    expect(body.scenario.user_task.amount).toBe(49900);
    expect(body.scenario.mandate.maximum_amount).toBe(49900);
    expect(saved).toHaveBeenCalledOnce();
  });
  it("converts decimal currency without floating point rounding and rejects unsupported precision", () => {
    expect(parseCurrencyInput("0.29")).toBe(29);
    expect(parseCurrencyInput("2500.01")).toBe(250001);
    for (const value of ["1.001", "-1", "Infinity", "1e5", "9007199254740993"])
      expect(() => parseCurrencyInput(value)).toThrow();
  });
});

// A saved suite can deliberately pin an older immutable scenario version.
import { loadScenarios } from "../../../packages/external-runner/src/scenarios";
import type { PlatformService } from "../server/platform/service";
import { ProjectTests } from "./ProjectsApp";

const starter = (await loadScenarios("scenarios/external-refunds"))[0];
if (!starter) throw new Error("Missing reviewed scenario");
function versionedDetail(): Awaited<ReturnType<PlatformService["project"]>> {
  if (!starter) throw new Error("Missing reviewed scenario");
  const createdAt = "2026-09-05T12:00:00Z";
  const project = {
    id: "owned",
    ownerId: "one",
    repository: {
      id: 1,
      installationId: 1,
      owner: "owner",
      name: "repo",
      defaultBranch: "main",
      private: true,
    },
    branch: "main",
    model: "configured",
    automaticRuns: true,
    integration: "ready" as const,
    createdAt,
  };
  const tests = [
    {
      id: "a-v1",
      testId: "a",
      version: 1,
      scenario: { ...starter, id: "custom-a", name: "First test" },
    },
    {
      id: "b-v1",
      testId: "b",
      version: 1,
      scenario: { ...starter, id: "custom-b", name: "Second test" },
    },
    {
      id: "a-v2",
      testId: "a",
      version: 2,
      scenario: { ...starter, id: "custom-a", name: "First test revised" },
    },
  ].map((test) => ({
    ...test,
    ownerId: "one",
    projectId: "owned",
    source: "custom" as const,
    createdAt,
  }));
  return {
    project,
    tests,
    suites: [
      {
        id: "suite",
        ownerId: "one",
        projectId: "owned",
        name: "Default",
        testVersionIds: ["a-v1"],
      },
    ],
    jobs: [],
    events: [],
    runs: [],
    pullRequests: [],
  };
}
describe("test identity and visible immutable selections", () => {
  it("shows and can deselect a pinned v1 after v2 exists, without silently upgrading it", async () => {
    const onRun = vi.fn();
    render(
      <ProjectTests
        detail={versionedDetail()}
        templates={[]}
        busy={false}
        refresh={vi.fn()}
        onRun={onRun}
      />,
    );
    const old = screen.getByRole("checkbox", {
      name: /First test Custom · version 1/,
    });
    expect((old as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Historical selection/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Run 1 selected tests" }),
    );
    expect(onRun).toHaveBeenCalledWith(["a-v1"], undefined);
    await userEvent.click(old);
    expect(
      (
        screen.getByRole("button", {
          name: "Run 0 selected tests",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("requires closing the current editor before editing another test and saves the second test's own values", async () => {
    request.mockResolvedValue({});
    const detail = versionedDetail();
    detail.tests = detail.tests.filter((test) => test.version === 1);
    render(
      <ProjectTests
        detail={detail}
        templates={[]}
        busy={false}
        refresh={vi.fn()}
        onRun={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getAllByRole("button", { name: "Edit test" })[0] as HTMLElement,
    );
    expect((screen.getByLabelText("Test name") as HTMLInputElement).value).toBe(
      "First test",
    );
    expect(
      (
        screen.getAllByRole("button", {
          name: "Edit test",
        })[1] as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      screen.getAllByRole("button", { name: "Edit test" })[1] as HTMLElement,
    );
    expect((screen.getByLabelText("Test name") as HTMLInputElement).value).toBe(
      "Second test",
    );
    await userEvent.click(screen.getByRole("button", { name: /Save test/ }));
    const body = JSON.parse(request.mock.calls[0]?.[1].body);
    expect(body.testId).toBe("b");
    expect(body.scenario.name).toBe("Second test");
  });
});
