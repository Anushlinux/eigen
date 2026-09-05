import type { Finding, TraceEvent } from "./types";
import { eventLabel } from "./view-model";

interface EvidenceInspectorProps {
  event: TraceEvent | undefined;
  findings: Finding[];
  httpSummary?: unknown | undefined;
  comparisonNote?: string | undefined;
}

export function EvidenceInspector({
  event,
  findings,
  httpSummary,
  comparisonNote,
}: EvidenceInspectorProps) {
  const linkedFindings = event
    ? findings.filter((finding) =>
        finding.evidence_event_ids.includes(event.id),
      )
    : [];

  return (
    <section className="evidence-inspector" aria-labelledby="evidence-heading">
      <div className="inspector-summary">
        <h2 id="evidence-heading">
          {event ? eventLabel(event) : "Select evidence"}
        </h2>
        <p>
          {comparisonNote ??
            (event
              ? "This is the exact recorded payload behind the selected step."
              : "Choose any trace step to inspect its payload and deterministic findings.")}
        </p>
      </div>
      <dl className="inspector-identifiers">
        <div>
          <dt>Event</dt>
          <dd>{event?.id ?? "—"}</dd>
        </div>
        <div>
          <dt>Correlation</dt>
          <dd>{event?.correlation_id ?? "none"}</dd>
        </div>
        <div>
          <dt>Sequence</dt>
          <dd>{event ? String(event.sequence).padStart(2, "0") : "—"}</dd>
        </div>
      </dl>
      <div className="inspector-payload">
        <div className="payload-heading">
          <h3>Structured payload</h3>
          <span>{event?.type ?? "waiting"}</span>
        </div>
        <pre>
          {event
            ? JSON.stringify(event.payload, null, 2)
            : "No event selected."}
        </pre>
      </div>
      <div className="inspector-links">
        <div>
          <h3>Linked findings</h3>
          {linkedFindings.length === 0 ? (
            <p className="quiet-line">
              No deterministic finding links to this event.
            </p>
          ) : (
            <ul>
              {linkedFindings.map((finding) => (
                <li key={`${finding.code}-${finding.explanation}`}>
                  <strong>{finding.code}</strong>
                  <span>{finding.explanation}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {httpSummary !== undefined ? (
          <div>
            <h3>HTTP exchange</h3>
            <pre>{JSON.stringify(httpSummary, null, 2)}</pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}
