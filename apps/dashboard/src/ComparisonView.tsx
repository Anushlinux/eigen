import { useMemo, useState } from "react";
import { EvidenceInspector } from "./EvidenceInspector";
import type {
  ComparisonAgentResult,
  ComparisonReport,
  Finding,
  RunReport,
  TraceEvent,
} from "./types";
import { milestonesForRun } from "./view-model";

interface SelectedEvidence {
  event: TraceEvent | undefined;
  findings: Finding[];
  side: "baseline" | "candidate";
}

function decisionLabel(value: "pass" | "block") {
  return value === "pass" ? "ALLOW" : "BLOCK";
}

function findRun(agent: ComparisonAgentResult, scenarioId: string): RunReport {
  const run =
    agent.runs.find((candidate) => candidate.scenario_id === scenarioId) ??
    agent.runs[0];
  if (!run) throw new Error(`No run exists for ${agent.agent_id}.`);
  return run;
}

function Recorder({
  trackRole,
  agent,
  run,
  selectedEventId,
  onSelect,
}: {
  trackRole: "BASELINE" | "CANDIDATE";
  agent: ComparisonAgentResult;
  run: RunReport;
  selectedEventId: string | undefined;
  onSelect(event: TraceEvent | undefined): void;
}) {
  const milestones = milestonesForRun(run);
  return (
    <article className={`recorder recorder--${trackRole.toLowerCase()}`}>
      <header className="recorder-header">
        <div>
          <span className="recorder-role">{trackRole}</span>
          <h2>{agent.agent_id}</h2>
        </div>
        <span
          className={`decision-stamp decision-stamp--${agent.summary.decision}`}
        >
          {decisionLabel(agent.summary.decision)}
        </span>
      </header>
      <fieldset className="recorder-track">
        <legend className="visually-hidden">{trackRole} trace</legend>
        <span className="track-line" aria-hidden="true" />
        {milestones.map((milestone, index) => (
          <button
            className={`milestone milestone--${milestone.tone}`}
            key={milestone.id}
            type="button"
            aria-pressed={milestone.event?.id === selectedEventId}
            style={{ gridColumn: milestone.slot }}
            onClick={() => onSelect(milestone.event)}
          >
            <span className="milestone-number">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="milestone-node" aria-hidden="true" />
            <strong>{milestone.label}</strong>
            <span>{milestone.detail}</span>
          </button>
        ))}
      </fieldset>
    </article>
  );
}

function DeltaColumn({
  report,
  baselineRun,
  candidateRun,
}: {
  report: ComparisonReport;
  baselineRun: RunReport;
  candidateRun: RunReport;
}) {
  const baseline = report.baseline.summary;
  const candidate = report.candidate.summary;
  const baselineRefunds = baselineRun.final_world.refunds.length;
  const candidateRefunds = candidateRun.final_world.refunds.length;
  const rows = [
    ["Refunds", baselineRefunds, candidateRefunds],
    [
      "Duplicate effects",
      baseline.duplicate_financial_effects,
      candidate.duplicate_financial_effects,
    ],
    [
      "Safe completion",
      `${baseline.safe_completion_rate}%`,
      `${candidate.safe_completion_rate}%`,
    ],
    [
      "Decision",
      decisionLabel(baseline.decision),
      decisionLabel(candidate.decision),
    ],
  ];
  return (
    <aside className="delta-column" aria-label="Comparison deltas">
      <div className="delta-heading">
        <span>Evidence delta</span>
        <strong>
          {report.critical_findings_removed.length} critical removed
        </strong>
      </div>
      <dl>
        {rows.map(([label, before, after]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <span>{before}</span>
              <span className="delta-arrow" aria-hidden="true">
                →
              </span>
              <strong>{after}</strong>
            </dd>
          </div>
        ))}
      </dl>
      <div className="finding-delta">
        <span>Critical findings</span>
        {report.critical_findings_removed.length > 0 ? (
          report.critical_findings_removed.map((finding) => (
            <strong key={`${finding.scenario_id}-${finding.code}`}>
              − {finding.code.replaceAll("_", " ")}
            </strong>
          ))
        ) : (
          <strong>None removed</strong>
        )}
        {report.critical_findings_added.map((finding) => (
          <strong
            className="finding-added"
            key={`${finding.scenario_id}-${finding.code}`}
          >
            + {finding.code.replaceAll("_", " ")}
          </strong>
        ))}
      </div>
    </aside>
  );
}

function MobileComparisonStack({
  baselineRun,
  candidateRun,
  selectedEventId,
  onSelect,
}: {
  baselineRun: RunReport;
  candidateRun: RunReport;
  selectedEventId: string | undefined;
  onSelect(side: "baseline" | "candidate", event: TraceEvent | undefined): void;
}) {
  const baseline = milestonesForRun(baselineRun);
  const candidate = milestonesForRun(candidateRun);
  const slots = Array.from({ length: 8 }, (_, index) => index + 1).filter(
    (slot) =>
      baseline.some((milestone) => milestone.slot === slot) ||
      candidate.some((milestone) => milestone.slot === slot),
  );
  return (
    <ol
      className="mobile-comparison-stack"
      aria-label="Ordered comparison evidence"
    >
      {slots.map((slot) => {
        const baselineMilestone = baseline.find(
          (milestone) => milestone.slot === slot,
        );
        const candidateMilestone = candidate.find(
          (milestone) => milestone.slot === slot,
        );
        const isFault = slot === 3;
        return (
          <li
            key={slot}
            className={
              isFault ? "mobile-phase mobile-phase--fault" : "mobile-phase"
            }
          >
            <div className="mobile-phase-marker">
              <span>Phase {String(slot).padStart(2, "0")}</span>
              {isFault ? <strong>Shared response lost</strong> : null}
            </div>
            {baselineMilestone ? (
              <button
                type="button"
                aria-pressed={baselineMilestone.event?.id === selectedEventId}
                onClick={() => onSelect("baseline", baselineMilestone.event)}
              >
                <span>Baseline</span>
                <strong>{baselineMilestone.label}</strong>
                <small>{baselineMilestone.detail}</small>
              </button>
            ) : (
              <div className="mobile-phase-empty">Baseline · no action</div>
            )}
            {candidateMilestone ? (
              <button
                type="button"
                aria-pressed={candidateMilestone.event?.id === selectedEventId}
                onClick={() => onSelect("candidate", candidateMilestone.event)}
              >
                <span>Candidate</span>
                <strong>{candidateMilestone.label}</strong>
                <small>{candidateMilestone.detail}</small>
              </button>
            ) : (
              <div className="mobile-phase-empty">Candidate · no action</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function ComparisonView({ report }: { report: ComparisonReport }) {
  const defaultScenario =
    report.scenarios.find((scenario) =>
      scenario.scenario_id.includes("timeout-after"),
    ) ?? report.scenarios[0];
  const [scenarioId, setScenarioId] = useState(
    defaultScenario?.scenario_id ?? "",
  );
  const baselineRun = findRun(report.baseline, scenarioId);
  const candidateRun = findRun(report.candidate, scenarioId);
  const [selected, setSelected] = useState<SelectedEvidence>(() => {
    const event = baselineRun.trace.find(
      (entry) => entry.type === "agent.retry",
    );
    return { side: "baseline", event, findings: baselineRun.findings };
  });
  const activeScenario = report.scenarios.find(
    (scenario) => scenario.scenario_id === scenarioId,
  );
  const divergenceNote = useMemo(() => {
    const baselineRetries = baselineRun.trace.some(
      (event) => event.type === "agent.retry",
    );
    const candidateReconciles = candidateRun.trace.some(
      (event) => event.type === "agent.reconciliation.completed",
    );
    if (baselineRetries && candidateReconciles) {
      return "Baseline retries the ambiguous mutation. Candidate reconciles provider state and finds the committed refund.";
    }
    return "Both traces are aligned to the same user task and deterministic scenario.";
  }, [baselineRun, candidateRun]);

  function selectScenario(nextId: string) {
    setScenarioId(nextId);
    const nextRun = findRun(report.baseline, nextId);
    setSelected({
      side: "baseline",
      event:
        nextRun.trace.find((entry) => entry.type === "fault.injected") ??
        nextRun.trace[0],
      findings: nextRun.findings,
    });
  }

  return (
    <main className="comparison-view">
      <section className="comparison-intro" aria-labelledby="comparison-title">
        <div>
          <h1 id="comparison-title">One intent. Two trajectories.</h1>
          <p>
            The same authorised refund crosses the same lost-response fault. The
            trace shows the first point where behaviour changes.
          </p>
        </div>
        <div className="comparison-verdict">
          <span>Candidate decision</span>
          <strong className={`verdict verdict--${report.decision}`}>
            {decisionLabel(report.decision)}
          </strong>
        </div>
      </section>

      <nav className="scenario-row" aria-label="Scenarios">
        {report.scenarios.map((scenario) => (
          <button
            type="button"
            key={scenario.scenario_id}
            aria-current={
              scenario.scenario_id === scenarioId ? "true" : undefined
            }
            onClick={() => selectScenario(scenario.scenario_id)}
          >
            <span
              className={`scenario-status scenario-status--${scenario.candidate_result}`}
            />
            {scenario.scenario_name}
          </button>
        ))}
      </nav>

      <section className="paired-recorders" aria-label="Aligned agent traces">
        <div className="fault-seam" aria-hidden="true">
          <span>Response lost</span>
        </div>
        <div className="recorders">
          <Recorder
            trackRole="BASELINE"
            agent={report.baseline}
            run={baselineRun}
            selectedEventId={selected.event?.id}
            onSelect={(event) =>
              setSelected({
                side: "baseline",
                event,
                findings: baselineRun.findings,
              })
            }
          />
          <Recorder
            trackRole="CANDIDATE"
            agent={report.candidate}
            run={candidateRun}
            selectedEventId={selected.event?.id}
            onSelect={(event) =>
              setSelected({
                side: "candidate",
                event,
                findings: candidateRun.findings,
              })
            }
          />
        </div>
        <MobileComparisonStack
          baselineRun={baselineRun}
          candidateRun={candidateRun}
          selectedEventId={selected.event?.id}
          onSelect={(side, event) =>
            setSelected({
              side,
              event,
              findings:
                side === "baseline"
                  ? baselineRun.findings
                  : candidateRun.findings,
            })
          }
        />
        <DeltaColumn
          report={report}
          baselineRun={baselineRun}
          candidateRun={candidateRun}
        />
      </section>

      <div className="divergence-band">
        <strong>Baseline retries</strong>
        <span aria-hidden="true">/</span>
        <strong>Candidate reconciles</strong>
        <p>{activeScenario?.scenario_name ?? scenarioId}</p>
      </div>
      <EvidenceInspector
        event={selected.event}
        findings={selected.findings}
        comparisonNote={divergenceNote}
      />
    </main>
  );
}
