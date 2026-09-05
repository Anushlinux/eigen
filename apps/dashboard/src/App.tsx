import { useCallback, useEffect, useState } from "react";
import { fetchComparison, fetchReports, fetchStatus } from "./api";
import { ComparisonView } from "./ComparisonView";
import { ExternalComparisonView } from "./ExternalComparisonView";
import { ExternalView } from "./ExternalView";
import type { ExternalSelection } from "./external-job-types";
import { RunsView } from "./RunsView";
import type { ComparisonReport, DashboardStatus, ReportSummary } from "./types";

type View = "compare" | "runs" | "external";

export function App() {
  const [compareMode, setCompareMode] = useState<"builtin" | "external">(
    "builtin",
  );
  const [externalSelection, setExternalSelection] =
    useState<ExternalSelection>();
  const [view, setView] = useState<View>("compare");
  const [status, setStatus] = useState<DashboardStatus | undefined>();
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [comparison, setComparison] = useState<ComparisonReport | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | undefined>();
  const [comparisonError, setComparisonError] = useState<string | undefined>();
  const [comparisonLoading, setComparisonLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    const nextSummaries = await fetchReports();
    setSummaries(nextSummaries);
    return nextSummaries;
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([fetchStatus(), loadHistory()])
      .then(([nextStatus, nextSummaries]) => {
        if (active) {
          setStatus(nextStatus);
          if (nextSummaries.some((summary) => summary.kind === "external")) {
            setView("external");
          }
          setState("ready");
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Dashboard data could not be loaded.",
          );
          setState("error");
        }
      });
    return () => {
      active = false;
    };
  }, [loadHistory]);

  useEffect(() => {
    if (state !== "ready" || view !== "compare" || compareMode !== "builtin")
      return;
    const summary = summaries.find((item) => item.kind === "comparison");
    if (!summary) return;
    let active = true;
    setComparisonLoading(true);
    fetchComparison(summary.id)
      .then((report) => {
        if (active) {
          setComparison(report);
          setComparisonError(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setComparisonError(
            reason instanceof Error
              ? reason.message
              : "Comparison could not be loaded.",
          );
      })
      .finally(() => {
        if (active) setComparisonLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state, view, summaries, compareMode]);

  return (
    <div className="app-shell">
      <header className="top-rail">
        <a className="wordmark" href="/" aria-label="Eigen dashboard">
          EIGEN
        </a>
        <nav aria-label="Primary">
          <button
            type="button"
            aria-current={view === "external" ? "page" : undefined}
            onClick={() => {
              setExternalSelection(undefined);
              setView("external");
            }}
          >
            External evaluations
          </button>
          <button
            type="button"
            aria-current={view === "runs" ? "page" : undefined}
            onClick={() => setView("runs")}
          >
            Runs
          </button>
          <button
            type="button"
            aria-current={view === "compare" ? "page" : undefined}
            onClick={() => setView("compare")}
          >
            Compare
          </button>
        </nav>
        <div className="environment-labels">
          <span>
            {view === "runs" ? "Razorpay Test Mode" : "Simulated payments"}
          </span>
          <strong>
            {view === "external"
              ? "Run and inspect evaluations"
              : view === "compare"
                ? "Saved comparison evidence"
                : "Saved smoke evidence"}
          </strong>
        </div>
      </header>

      {state === "loading" ? (
        <main className="system-state" aria-live="polite">
          <span className="calibration-line" aria-hidden="true" />
          <h1>Loading flight records</h1>
          <p>Reading local, validated report history.</p>
        </main>
      ) : null}
      {state === "error" ? (
        <main className="system-state system-state--error">
          <h1>Evidence could not be loaded</h1>
          <p>
            {error} Confirm the local server can read the repository reports
            directory.
          </p>
        </main>
      ) : null}
      {state === "ready" && view === "compare" ? (
        <nav className="comparison-mode" aria-label="Comparison type">
          <button
            type="button"
            aria-pressed={compareMode === "builtin"}
            onClick={() => setCompareMode("builtin")}
          >
            Built-in agents
          </button>
          <button
            type="button"
            aria-pressed={compareMode === "external"}
            onClick={() => setCompareMode("external")}
          >
            External suites
          </button>
        </nav>
      ) : null}
      {state === "ready" && view === "compare" && compareMode === "external" ? (
        <ExternalComparisonView
          summaries={summaries}
          onInspect={(selection) => {
            setExternalSelection(selection);
            setView("external");
          }}
        />
      ) : null}
      {state === "ready" && view === "compare" && compareMode === "builtin" ? (
        comparisonLoading ? (
          <main className="system-state" role="status">
            Loading comparison…
          </main>
        ) : comparisonError ? (
          <main className="system-state" role="alert">
            {comparisonError}
          </main>
        ) : comparison ? (
          <ComparisonView report={comparison} />
        ) : (
          <main className="system-state">
            <h1>No comparison record yet</h1>
            <p>
              Run the existing safe-versus-flawed comparison to create the first
              immutable record.
            </p>
            <code>pnpm compare-demo</code>
          </main>
        )
      ) : null}
      {state === "ready" && view === "external" ? (
        <ExternalView
          summaries={summaries}
          onHistoryChanged={loadHistory}
          selection={externalSelection}
        />
      ) : null}
      {state === "ready" && view === "runs" && status ? (
        <RunsView
          status={status}
          summaries={summaries}
          onHistoryChanged={loadHistory}
        />
      ) : null}
      <footer className="app-footer">
        <span>Financial correctness is decided by deterministic code.</span>
        <span>Local interface · no credential values sent to browser</span>
      </footer>
    </div>
  );
}
