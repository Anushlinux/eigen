// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/external-suite.json";
import { externalSuiteReportSchema } from "../server/external-report-schema";
import { ExternalComparisonView } from "./ExternalComparisonView";
import type { ReportSummary } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("external suite comparison UI", () => {
  it("shows historical outcomes without comparability and opens the exact selected trial", async () => {
    const before = externalSuiteReportSchema.parse(structuredClone(fixture));
    const after = {
      ...before,
      suite_id: "suite_after",
      application: { ...before.application, contentHash: "b".repeat(64) },
    };
    const summaries: ReportSummary[] = [after, before].map((suite) => ({
      kind: "external",
      id: suite.suite_id,
      subject: suite.application.id,
      created_at: null,
      decision: suite.decision,
      schema_version: suite.schema_version,
    }));
    const fetch = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            report: url.endsWith("suite_after") ? after : before,
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const onInspect = vi.fn();
    const user = userEvent.setup();
    render(
      <ExternalComparisonView summaries={summaries} onInspect={onInspect} />,
    );
    expect(
      await screen.findByRole("heading", { name: "Not directly comparable" }),
    ).toBeTruthy();
    expect(
      screen.getAllByText(/Unavailable — expectation provenance/).length,
    ).toBe(4);
    const first = before.runs[0]?.report;
    if (!first) throw new Error("Missing fixture trial");
    const region = screen.getByRole("region", {
      name: `${first.scenario_name} after`,
    });
    await user.click(
      within(region).getByRole("button", {
        name: `Trial ${first.run_number} · ${first.result.toUpperCase()}`,
      }),
    );
    expect(onInspect).toHaveBeenCalledWith({
      suiteId: after.suite_id,
      scenarioId: first.scenario_id,
      trial: first.run_number,
    });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "After suite" }),
      before.suite_id,
    );
    expect(await screen.findByText(/same suite is selected/)).toBeTruthy();
    expect(
      fetch.mock.calls.every(([url]) =>
        String(url).startsWith("/api/reports/external/"),
      ),
    ).toBe(true);
  });

  it("shows unavailable evidence without inventing results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "The saved evidence is incomplete." }),
            { status: 422 },
          ),
      ),
    );
    const summaries: ReportSummary[] = [
      {
        kind: "external",
        id: "bad",
        subject: "reference",
        created_at: null,
        decision: null,
        schema_version: "1.0",
      },
    ];
    render(
      <ExternalComparisonView summaries={summaries} onInspect={vi.fn()} />,
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("saved evidence is incomplete"),
    );
    expect(
      screen.queryByRole("heading", {
        name: "Matching evaluation configuration",
      }),
    ).toBeNull();
  });
});
