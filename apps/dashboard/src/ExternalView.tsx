import { useCallback, useEffect, useState } from "react";
import type {
  ExternalRunReport,
  ExternalSuiteReport,
} from "../server/external-report-schema";
import { fetchExternal } from "./api";
import { EvidenceInspector } from "./EvidenceInspector";
import { ExternalLauncher } from "./ExternalLauncher";
import { remediationGuidance } from "./external-guidance";
import type { ExternalSelection } from "./external-job-types";
import {
  causalSteps,
  externalRunKey,
  financialSummary,
  formatMinorUnits,
} from "./external-view-model";
import type { ReportSummary } from "./types";

export function TrialDetail({ run }: { run: ExternalRunReport }) {
  const [findingIndex, setFindingIndex] = useState(() =>
    Math.max(
      0,
      run.findings.findIndex(
        (finding) => finding.code === "DUPLICATE_FINANCIAL_EFFECT",
      ),
    ),
  );
  const finding = run.findings[findingIndex];
  const sequence = causalSteps(run, finding);
  const guidance = finding ? remediationGuidance(run, finding) : undefined;
  const [eventId, setEventId] = useState<string | undefined>(
    sequence.steps[0]?.id,
  );
  const event = run.trace.find((item) => item.id === eventId);
  const finance = financialSummary(run);
  const claimEvent = run.trace.find(
    (item) => item.type === "agent.final_claim",
  );
  const modelEvents = run.trace.filter(
    (item) => item.type === "model.tool.selected",
  );
  const paymentEvents = run.trace.filter(
    (item) =>
      item.type === "tool.call.requested" &&
      item.payload.operation === "create_refund",
  );
  const model = run.trace.find(
    (item) => item.type === "agent.configuration.loaded",
  )?.payload.model;
  const financialFindings = run.findings.filter(
    (item) => item.category === "financial_safety",
  );

  function selectFinding(index: number) {
    setFindingIndex(index);
    const next = run.findings[index];
    setEventId(
      next?.evidence_event_ids.find((id) =>
        run.trace.some((item) => item.id === id),
      ),
    );
  }

  return (
    <article className="external-trial" aria-labelledby="trial-title">
      <header className="external-trial-heading">
        <div>
          <h2 id="trial-title">
            {run.scenario_name} · Trial {run.run_number}
          </h2>
          <p>
            <code>{run.scenario_id}</code> · Run <code>{run.run_id}</code>
          </p>
        </div>
        <div className="external-verdict">
          <strong>Verdict: {run.result.toUpperCase()}</strong>
          <span
            className={`decision-stamp decision-stamp--${run.deployment_decision === "allow" ? "pass" : "block"}`}
          >
            Deployment: {run.deployment_decision.toUpperCase()}
          </span>
        </div>
      </header>

      {run.agent_error ? (
        <section
          className="external-execution-error"
          aria-label="Execution error"
        >
          <h3>Application / model execution error</h3>
          <p>
            <strong>{run.agent_error.code}</strong>: {run.agent_error.message}
          </p>
          <p>
            {financialFindings.length === 0
              ? "No financial violation is demonstrated by the recorded financial findings. The execution error still prevents this trial from passing."
              : "Financial findings below are separate from this execution error."}
          </p>
        </section>
      ) : null}

      <section
        className="external-finance"
        aria-label="Authorisation and observed refunds"
      >
        <dl>
          <div>
            <dt>Authorised</dt>
            <dd>
              {formatMinorUnits(
                finance.authorizedPerRefundMinor,
                finance.currency,
              )}{" "}
              {finance.maximumRefundCount === 1
                ? "once"
                : `per refund, up to ${finance.maximumRefundCount} times`}
            </dd>
          </div>
          <div>
            <dt>Observed in this simulation</dt>
            <dd>
              {finance.committedRefundCount}{" "}
              {finance.committedRefundCount === 1 ? "refund" : "refunds"} ·{" "}
              {formatMinorUnits(finance.totalCommittedMinor, finance.currency)}{" "}
              total
            </dd>
          </div>
          <div>
            <dt>Amount beyond authorisation</dt>
            <dd>{formatMinorUnits(finance.excessMinor, finance.currency)}</dd>
          </div>
        </dl>
        <p className="quiet-line">
          New committed refunds for mandate <code>{run.mandate.id}</code>. These
          are simulated effects, not live losses or bank settlement.
        </p>
        {finance.committedRefunds.length > 0 ? (
          <ul className="external-refunds">
            {finance.committedRefunds.map((refund) => (
              <li key={refund.id}>
                <code>{refund.id}</code>
                <strong>
                  {formatMinorUnits(refund.amount, refund.currency)}
                </strong>
                <span>{refund.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No new committed refunds recorded for this mandate.</p>
        )}
        {finance.otherCurrencyTotals.map((total) => (
          <p key={total.currency}>
            Other currency, kept separate:{" "}
            {formatMinorUnits(total.amountMinor, total.currency)}. No currency
            conversion is applied.
          </p>
        ))}
      </section>

      <section className="external-claim" aria-label="Recorded claim">
        <h3>
          {run.final_claim_source === "agent"
            ? "Recorded agent claim"
            : "Eigen-generated fallback claim"}
        </h3>
        <blockquote>{run.final_claim.message}</blockquote>
        {run.final_claim_source !== "agent" ? (
          <p>
            The application did not supply this statement. Eigen generated it
            after execution failed.
          </p>
        ) : null}
        <p>
          Status: {run.final_claim.status} · Claimed amount:{" "}
          {formatMinorUnits(run.final_claim.amount, run.final_claim.currency)} ·
          Refund IDs: {run.final_claim.refundIds.join(", ") || "none"}
        </p>
        {claimEvent ? (
          <button
            className="text-action"
            type="button"
            onClick={() => setEventId(claimEvent.id)}
          >
            Inspect original claim event
          </button>
        ) : (
          <p>Original claim event is missing from the trace.</p>
        )}
      </section>

      <section className="external-findings" aria-labelledby="findings-title">
        <h3 id="findings-title">Recorded evaluator findings</h3>
        {run.findings.length === 0 ? (
          <p>
            No findings recorded. Passing this trial does not establish general
            application safety.
          </p>
        ) : (
          <>
            <div className="external-finding-choices">
              {run.findings.map((item, index) => (
                <button
                  key={`${item.code}-${item.explanation}-${item.evidence_event_ids.join(",")}`}
                  type="button"
                  aria-pressed={findingIndex === index}
                  onClick={() => selectFinding(index)}
                >
                  {item.title} <span>{item.severity}</span>
                </button>
              ))}
            </div>
            {finding ? (
              <div className="external-finding-detail">
                <h4>{finding.code}</h4>
                <p>
                  <strong>{finding.severity.toUpperCase()}</strong> ·{" "}
                  {finding.category.replaceAll("_", " ")}
                </p>
                <p>{finding.explanation}</p>
                <div className="external-evidence-links">
                  {finding.evidence_event_ids.map((id) =>
                    run.trace.some((item) => item.id === id) ? (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setEventId(id)}
                      >
                        {id}
                      </button>
                    ) : (
                      <span key={id}>Missing evidence: {id}</span>
                    ),
                  )}
                </div>
                {finding.evidence_event_ids.length === 0 ? (
                  <p>This finding has no linked evidence IDs.</p>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </section>

      {guidance ? (
        <section
          className="external-guidance"
          aria-label="Remediation guidance"
        >
          <h3>{guidance.label}</h3>
          <p>{guidance.whatHappened}</p>
          <p>{guidance.cause}</p>
          <h4>What to inspect</h4>
          <p>{guidance.recommendation}</p>
          <div className="external-evidence-links">
            {guidance.evidenceEventIds.map((id) => (
              <button type="button" key={id} onClick={() => setEventId(id)}>
                Evidence {id}
              </button>
            ))}
          </div>
          {guidance.missingEvidenceEventIds.map((id) => (
            <p key={id}>Supporting event unavailable: {id}</p>
          ))}
        </section>
      ) : null}

      <section className="external-cause" aria-labelledby="cause-title">
        <h3 id="cause-title">What the trace supports</h3>
        <p>
          {typeof model === "string"
            ? `Recorded model: ${model}. `
            : "Model configuration is unavailable. "}
          {finance.modelToolSelections} model tool{" "}
          {finance.modelToolSelections === 1 ? "selection" : "selections"} ·{" "}
          {finance.refundPaymentRequests} refund payment{" "}
          {finance.refundPaymentRequests === 1 ? "request" : "requests"} ·{" "}
          {finance.paymentReads} payment{" "}
          {finance.paymentReads === 1 ? "read" : "reads"}.
        </p>
        {sequence.reason ? (
          <p className="external-evidence-note">{sequence.reason}</p>
        ) : (
          <p>
            The linked events show an application retry after the first refund
            response was lost.
          </p>
        )}
        {sequence.steps.length > 0 ? (
          <ol className="external-causal-steps">
            {sequence.steps.map((step) => (
              <li key={step.id}>
                <button
                  type="button"
                  aria-pressed={eventId === step.id}
                  onClick={() => setEventId(step.id)}
                >
                  <span>Event {step.event.sequence}</span>
                  <strong>{step.label}</strong>
                  <span>{step.detail}</span>
                </button>
                {step.eventIds.length > 1 ? (
                  <div className="external-step-links">
                    {step.eventIds
                      .filter((id) => id !== step.id)
                      .map((id) => (
                        <button
                          type="button"
                          key={id}
                          onClick={() => setEventId(id)}
                        >
                          Supporting event {id}
                        </button>
                      ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        <details className="external-secondary">
          <summary>Model selections and payment requests</summary>
          <p>
            Model tool selection and application payment requests are separate
            recorded events. The trace does not expose hidden model reasoning.
          </p>
          <h4>Model tool selections ({modelEvents.length})</h4>
          {modelEvents.map((item) => (
            <button
              className="text-action"
              key={item.id}
              type="button"
              onClick={() => setEventId(item.id)}
            >
              Event {item.sequence}: {String(item.payload.tool_name)}
            </button>
          ))}
          <h4>Refund payment requests ({paymentEvents.length})</h4>
          {paymentEvents.map((item) => (
            <button
              className="text-action"
              key={item.id}
              type="button"
              onClick={() => setEventId(item.id)}
            >
              Event {item.sequence}:{" "}
              {item.correlation_id ?? "No correlation ID"}
            </button>
          ))}
        </details>
      </section>

      <EvidenceInspector
        event={event}
        findings={run.findings}
        eventTitle={
          event?.type === "agent.retry"
            ? "Application retry"
            : sequence.steps.find((step) => step.id === event?.id)?.label
        }
      />
      <details className="external-secondary external-full-trace">
        <summary>Full trace ({run.trace.length} events)</summary>
        <p>
          Sequence numbers establish recorded order. Simulator timestamps use an
          injected logical clock; they are not wall-clock run dates.
        </p>
        <ol>
          {run.trace.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={eventId === item.id}
                onClick={() => setEventId(item.id)}
              >
                <span>{item.sequence}</span>
                <code>{item.type}</code>
                <span>{item.id}</span>
              </button>
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

function SuiteDetail({
  suite,
  selection,
}: {
  suite: ExternalSuiteReport;
  selection?: ExternalSelection | undefined;
}) {
  const scenarios = [
    ...new Map(
      suite.runs.map(({ report }) => [
        report.scenario_id,
        report.scenario_name,
      ]),
    ).entries(),
  ];
  const [scenarioId, setScenarioId] = useState(
    selection?.scenarioId ?? scenarios[0]?.[0] ?? "",
  );
  const runs = suite.runs
    .map((item) => item.report)
    .filter((run) => run.scenario_id === scenarioId);
  const [trial, setTrial] = useState(
    selection?.trial ?? runs[0]?.run_number ?? 1,
  );
  const selected = runs.find((run) => run.run_number === trial) ?? runs[0];
  return (
    <>
      <section className="external-suite" aria-label="Selected suite">
        <div className="external-suite-title">
          <h2>{suite.application.id}</h2>
          <strong>Suite deployment: {suite.decision.toUpperCase()}</strong>
        </div>
        <dl className="external-identifiers">
          <div>
            <dt>Suite ID</dt>
            <dd>{suite.suite_id}</dd>
          </div>
          <div>
            <dt>Source hash · SHA-256</dt>
            <dd>{suite.application.contentHash}</dd>
          </div>
        </dl>
        <p>
          <strong>Simulated payments</strong> ·{" "}
          {suite.model_execution === "openai"
            ? "Live OpenAI inference was used for this saved evaluation"
            : "Model test double was used for this saved evaluation"}
          . Viewing this report makes no provider calls.
        </p>
        <p className="quiet-line">
          {scenarios.length} scenarios · {suite.runs.length} trials.{" "}
          {typeof suite.created_at === "string"
            ? `Evaluated ${new Date(suite.created_at).toLocaleString()}.`
            : "Wall-clock evaluation date was not recorded."}
        </p>
        <div className="external-selectors">
          <label>
            Scenario
            <select
              value={scenarioId}
              onChange={(event) => {
                setScenarioId(event.target.value);
                setTrial(
                  suite.runs.find(
                    (item) => item.report.scenario_id === event.target.value,
                  )?.report.run_number ?? 1,
                );
              }}
            >
              {scenarios.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Trial
            <select
              value={selected?.run_number ?? ""}
              onChange={(event) => setTrial(Number(event.target.value))}
            >
              {runs.map((run) => (
                <option
                  key={externalRunKey(
                    suite.suite_id,
                    run.scenario_id,
                    run.run_number,
                  )}
                  value={run.run_number}
                >
                  Trial {run.run_number} · {run.result.toUpperCase()} ·{" "}
                  {run.deployment_decision.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {selected ? (
        <TrialDetail
          key={externalRunKey(
            suite.suite_id,
            selected.scenario_id,
            selected.run_number,
          )}
          run={selected}
        />
      ) : (
        <p>No completed trial is available for this scenario.</p>
      )}
    </>
  );
}

export function ExternalView({
  summaries,
  onHistoryChanged,
  selection,
}: {
  summaries: ReportSummary[];
  onHistoryChanged?: (() => Promise<unknown>) | undefined;
  selection?: ExternalSelection | undefined;
}) {
  const history = summaries.filter((item) => item.kind === "external");
  const [selectedId, setSelectedId] = useState(
    selection?.suiteId ??
      history.find(
        (item) => !item.availability || item.availability === "ready",
      )?.id ??
      history[0]?.id ??
      "",
  );
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; suite: ExternalSuiteReport }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const selected = history.find((item) => item.id === selectedId);
  const openCompleted = useCallback(
    async (suiteId: string) => {
      await onHistoryChanged?.();
      setSelectedId(suiteId);
    },
    [onHistoryChanged],
  );
  useEffect(() => {
    if (selection) setSelectedId(selection.suiteId);
  }, [selection]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setState({ kind: "loading" });
    fetchExternal(selectedId)
      .then((suite) => {
        if (active) setState({ kind: "ready", suite });
      })
      .catch((reason: unknown) => {
        if (active)
          setState({
            kind: "error",
            message:
              reason instanceof Error
                ? reason.message
                : "External evidence could not be loaded.",
          });
      });
    return () => {
      active = false;
    };
  }, [selectedId]);
  return (
    <main className="external-view">
      <section className="runs-heading">
        <div>
          <h1>External evaluations</h1>
          <p>
            Run the refund application, inspect its evidence, and compare
            observed outcomes.
          </p>
        </div>
      </section>
      <ExternalLauncher onCompleted={openCompleted} />
      {history.length === 0 && !selectedId ? (
        <section className="system-state">
          <h2>No saved external suites</h2>
          <p>
            Run the reviewed suite above to create the first saved evaluation.
            Opening evidence never launches another evaluation.
          </p>
        </section>
      ) : (
        <>
          <label className="external-suite-picker">
            Saved suite
            <select
              value={selectedId}
              onChange={(event) => {
                setState({ kind: "loading" });
                setSelectedId(event.target.value);
              }}
            >
              {history.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.subject} · {item.id} ·{" "}
                  {item.availability && item.availability !== "ready"
                    ? item.availability.toUpperCase()
                    : item.decision?.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          {state.kind === "loading" ? (
            <p role="status">Loading saved suite…</p>
          ) : state.kind === "error" ? (
            <section className="system-state system-state--error" role="alert">
              <h2>External evidence unavailable</h2>
              <p>{selected?.message ?? state.message}</p>
              <p>
                Select another suite or check the saved report. Source evidence
                has not been changed.
              </p>
            </section>
          ) : (
            <SuiteDetail
              key={`${selectedId}:${state.suite.suite_id}:${selection?.scenarioId ?? ""}:${selection?.trial ?? ""}`}
              suite={state.suite}
              selection={
                selection?.suiteId === state.suite.suite_id
                  ? selection
                  : undefined
              }
            />
          )}
        </>
      )}
    </main>
  );
}
