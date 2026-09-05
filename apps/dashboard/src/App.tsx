import { useCallback, useEffect, useState } from "react";
import { fetchComparison, fetchReports, fetchStatus } from "./api";
import { ComparisonView } from "./ComparisonView";
import { RunsView } from "./RunsView";
import type { ComparisonReport, DashboardStatus, ReportSummary } from "./types";

type View = "compare" | "runs";

export function App() {
  const [view, setView] = useState<View>("compare");
  const [status, setStatus] = useState<DashboardStatus | undefined>();
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [comparison, setComparison] = useState<ComparisonReport | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | undefined>();

  const loadHistory = useCallback(async () => {
    const nextSummaries = await fetchReports();
    setSummaries(nextSummaries);
    return nextSummaries;
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([fetchStatus(), loadHistory()])
      .then(async ([nextStatus, nextSummaries]) => {
        const comparisonSummary = nextSummaries.find(
          (summary) => summary.kind === "comparison",
        );
        const nextComparison = comparisonSummary
          ? await fetchComparison(comparisonSummary.id)
          : undefined;
        if (active) {
          setStatus(nextStatus);
          setComparison(nextComparison);
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

  return (
    <div className="app-shell">
      <header className="top-rail">
        <a className="wordmark" href="/" aria-label="Eigen dashboard">
          EIGEN
        </a>
        <nav aria-label="Primary">
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
          <span>Test mode only</span>
          <strong>Offline verified</strong>
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
        comparison ? (
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
