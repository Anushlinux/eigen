import { useEffect, useState } from "react";
import { externalSuiteReportSchema } from "../server/external-report-schema";
import type { ProjectRun } from "../server/platform/types";
import { apiJson } from "./api";
import { TrialDetail } from "./ExternalView";
import {
  compareExternalSuites,
  type ExternalSuiteComparison,
} from "./external-comparison";

export function ProjectRunDetail({
  projectId,
  runId,
  baselineId,
  onRepair,
  busy,
}: {
  projectId: string;
  runId: string;
  baselineId?: string | undefined;
  onRepair(id: string): void;
  busy: boolean;
}) {
  const [run, setRun] = useState<ProjectRun>();
  const [trial, setTrial] = useState(0);
  const [comparison, setComparison] = useState<ExternalSuiteComparison>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setRun(undefined);
    setError("");
    setComparison(undefined);
    setTrial(0);
    void apiJson<{ run: ProjectRun }>(
      `/api/projects/${projectId}/runs/${runId}`,
    )
      .then(async ({ run }) => {
        if (!active) return;
        externalSuiteReportSchema.parse(run.report);
        setRun(run);
        if (baselineId) {
          const baseline = await apiJson<{ run: ProjectRun }>(
            `/api/projects/${projectId}/runs/${baselineId}`,
          );
          const result = await compareExternalSuites(
            externalSuiteReportSchema.parse(baseline.run.report),
            externalSuiteReportSchema.parse(run.report),
          );
          if (active) setComparison(result);
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "Run evidence could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [projectId, runId, baselineId]);
  if (error)
    return (
      <p role="alert" className="project-error">
        {error}
      </p>
    );
  if (!run) return <p role="status">Loading recorded evidence…</p>;
  const suite = externalSuiteReportSchema.parse(run.report);
  const selected = suite.runs[trial]?.report;
  return (
    <section className="project-run-detail">
      <header className="project-section-heading">
        <div>
          <h2>
            {suite.decision === "allow"
              ? "Selected tests passed"
              : "Tests found a failure"}
          </h2>
          <p>
            Commit <code>{run.commit.slice(0, 12)}</code> · {run.model} ·
            simulated payments
          </p>
        </div>
        {suite.decision === "block" && (
          <button
            type="button"
            className="project-primary"
            disabled={busy}
            onClick={() => onRepair(run.id)}
          >
            Fix with agent
          </button>
        )}
      </header>
      {comparison && (
        <section className="project-comparison">
          <h3>Before and after</h3>
          <p>
            {comparison.directlyComparable
              ? "These runs use comparable evaluation settings."
              : "These runs have different settings. Treat their outcomes as separate evidence."}
          </p>
          {comparison.compatibilityReasons.map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
          <table>
            <thead>
              <tr>
                <th>Result</th>
                <th>Before</th>
                <th>Candidate</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Tests passed</th>
                <td>
                  {comparison.before.passedTrials} /{" "}
                  {comparison.before.totalTrials}
                </td>
                <td>
                  {comparison.after.passedTrials} /{" "}
                  {comparison.after.totalTrials}
                </td>
              </tr>
              <tr>
                <th>Financial violations</th>
                <td>{comparison.before.financialViolations}</td>
                <td>{comparison.after.financialViolations}</td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
      <label className="project-trial-picker">
        Inspect a test
        <select
          value={trial}
          onChange={(event) => setTrial(Number(event.target.value))}
        >
          {suite.runs.map(({ report }, index) => (
            <option key={report.run_id} value={index}>
              {report.scenario_name} ·{" "}
              {report.result === "pass" ? "Passed" : "Failed"}
            </option>
          ))}
        </select>
      </label>
      {selected && <TrialDetail key={selected.run_id} run={selected} />}
    </section>
  );
}
