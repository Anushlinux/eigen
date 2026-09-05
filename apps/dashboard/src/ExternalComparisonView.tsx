import { useEffect, useState } from "react";
import { fetchExternal } from "./api";
import {
  compareExternalSuites,
  type ExternalSuiteComparison,
  type ExternalSuiteOutcome,
  type ExternalTrialOutcome,
} from "./external-comparison";
import type { ExternalSelection } from "./external-job-types";
import type { ReportSummary } from "./types";

function SuiteOutcome({
  title,
  outcome,
}: {
  title: string;
  outcome: ExternalSuiteOutcome;
}) {
  return (
    <section
      className="external-comparison-outcome"
      aria-label={`${title} outcomes`}
    >
      <h2>{title}</h2>
      <dl className="external-identifiers">
        <div>
          <dt>Suite</dt>
          <dd>{outcome.suiteId}</dd>
        </div>
        <div>
          <dt>Application SHA-256</dt>
          <dd>{outcome.applicationHash}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{outcome.model ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt>Trials passed</dt>
          <dd>
            {outcome.passedTrials} / {outcome.totalTrials}
          </dd>
        </div>
        <div>
          <dt>Financial violations</dt>
          <dd>{outcome.financialViolations}</dd>
        </div>
        <div>
          <dt>Execution errors</dt>
          <dd>{outcome.executionErrors}</dd>
        </div>
        <div>
          <dt>Legitimate refund trials passed</dt>
          <dd>
            {outcome.legitimateCompletion
              ? `${outcome.legitimateCompletion.passed} / ${outcome.legitimateCompletion.total}`
              : "Unavailable — expectation provenance missing or invalid"}
          </dd>
        </div>
        <div>
          <dt>Refusal trials passed</dt>
          <dd>
            {outcome.refusalCompletion
              ? `${outcome.refusalCompletion.passed} / ${outcome.refusalCompletion.total}`
              : "Unavailable — expectation provenance missing or invalid"}
          </dd>
        </div>
      </dl>
      <details>
        <summary>Model settings, prompt and tool hashes</summary>
        <h3>Recorded model settings</h3>
        <pre>
          {JSON.stringify(outcome.configuration ?? "Not recorded", null, 2)}
        </pre>
        <h3>Prompt hashes</h3>
        {outcome.promptHashes.length ? (
          outcome.promptHashes.map((hash) => (
            <p key={hash}>
              <code>{hash}</code>
            </p>
          ))
        ) : (
          <p>Not recorded</p>
        )}
        <h3>Tool definition hashes</h3>
        {outcome.toolManifestHashes.length ? (
          outcome.toolManifestHashes.map((hash) => (
            <p key={hash}>
              <code>{hash}</code>
            </p>
          ))
        ) : (
          <p>Not recorded</p>
        )}
      </details>
    </section>
  );
}

function TrialOutcomes({
  trials,
  suiteId,
  scenarioId,
  onInspect,
}: {
  trials: ExternalTrialOutcome[];
  suiteId: string;
  scenarioId: string;
  onInspect(selection: ExternalSelection): void;
}) {
  if (!trials.length) return <p>No recorded trials</p>;
  return (
    <ul className="external-comparison-trials">
      {trials.map((trial) => (
        <li key={trial.runNumber}>
          <button
            type="button"
            onClick={() =>
              onInspect({ suiteId, scenarioId, trial: trial.runNumber })
            }
          >
            Trial {trial.runNumber} · {trial.result.toUpperCase()}
          </button>
          <span>
            {trial.financialViolations} financial violations
            {trial.executionError ? " · Execution error" : ""}
          </span>
          <span>
            {trial.taskExpectation === "complete"
              ? "Refund should complete"
              : trial.taskExpectation === "refuse"
                ? "Request should be refused"
                : "Expectation provenance unavailable"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ExternalComparisonView({
  summaries,
  onInspect,
}: {
  summaries: ReportSummary[];
  onInspect(selection: ExternalSelection): void;
}) {
  const history = summaries.filter((item) => item.kind === "external");
  const available = history.filter(
    (item) => !item.availability || item.availability === "ready",
  );
  const [beforeId, setBeforeId] = useState(
    available[1]?.id ?? available[0]?.id ?? history[0]?.id ?? "",
  );
  const [afterId, setAfterId] = useState(
    available[0]?.id ?? history[1]?.id ?? "",
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; comparison: ExternalSuiteComparison }
  >({ kind: "loading" });
  useEffect(() => {
    if (!beforeId || !afterId) return;
    let active = true;
    setState({ kind: "loading" });
    Promise.all([fetchExternal(beforeId), fetchExternal(afterId)])
      .then(([before, after]) => compareExternalSuites(before, after))
      .then((comparison) => {
        if (active) setState({ kind: "ready", comparison });
      })
      .catch((error) => {
        if (active)
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Saved comparison evidence could not be loaded.",
          });
      });
    return () => {
      active = false;
    };
  }, [beforeId, afterId]);
  const compared = state.kind === "ready" ? state.comparison : undefined;
  return (
    <main className="external-view external-comparison-view">
      <section className="runs-heading">
        <div>
          <h1>Compare external suites</h1>
          <p>
            Change your application outside Eigen, run another evaluation, then
            inspect both sets of observed outcomes.
          </p>
        </div>
      </section>
      {!history.length ? (
        <section className="system-state">
          <h2>No external evaluations to compare</h2>
          <p>
            Run an evaluation from External evaluations to create a saved suite.
          </p>
        </section>
      ) : (
        <>
          <div className="external-selectors external-comparison-selectors">
            <label>
              Before suite
              <select
                value={beforeId}
                onChange={(event) => setBeforeId(event.target.value)}
              >
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.subject} · {item.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              After suite
              <select
                value={afterId}
                onChange={(event) => setAfterId(event.target.value)}
              >
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.subject} · {item.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {state.kind === "loading" ? (
            <p role="status">Reading both saved suites…</p>
          ) : state.kind === "error" ? (
            <section role="alert" className="system-state system-state--error">
              <h2>Comparison evidence unavailable</h2>
              <p>{state.message}</p>
              <p>Select another saved suite. No evaluation has been started.</p>
            </section>
          ) : null}
          {compared ? (
            <>
              <section
                className="external-compatibility"
                aria-label="Comparison compatibility"
              >
                <h2>
                  {compared.directlyComparable
                    ? "Matching evaluation configuration"
                    : "Not directly comparable"}
                </h2>
                {beforeId === afterId ? (
                  <p>
                    The same suite is selected on both sides. Select another
                    suite to compare separate evaluations.
                  </p>
                ) : null}
                {compared.compatibilityReasons.length ? (
                  <ul>
                    {compared.compatibilityReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
                <p>{compared.conclusion}</p>
                <p>
                  Application, prompt, and tool hashes may differ. These results
                  do not establish which change caused an outcome.
                </p>
              </section>
              <div className="external-comparison-columns">
                <SuiteOutcome title="Before" outcome={compared.before} />
                <SuiteOutcome title="After" outcome={compared.after} />
              </div>
              <section aria-label="Scenario comparison">
                <h2>Observed trials by scenario</h2>
                {compared.scenarios.map((scenario) => (
                  <article
                    className="external-comparison-scenario"
                    key={scenario.scenarioId}
                  >
                    <h3>{scenario.scenarioName}</h3>
                    <p>
                      <code>{scenario.scenarioId}</code>
                    </p>
                    <div className="external-comparison-columns">
                      <section aria-label={`${scenario.scenarioName} before`}>
                        <h4>Before</h4>
                        <TrialOutcomes
                          trials={scenario.before}
                          suiteId={beforeId}
                          scenarioId={scenario.scenarioId}
                          onInspect={onInspect}
                        />
                      </section>
                      <section aria-label={`${scenario.scenarioName} after`}>
                        <h4>After</h4>
                        <TrialOutcomes
                          trials={scenario.after}
                          suiteId={afterId}
                          scenarioId={scenario.scenarioId}
                          onInspect={onInspect}
                        />
                      </section>
                    </div>
                  </article>
                ))}
              </section>
            </>
          ) : null}
        </>
      )}
    </main>
  );
}
