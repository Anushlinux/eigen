import { type FormEvent, useEffect, useMemo, useState } from "react";
import { fetchSmoke, preflightSmoke, runSmoke } from "./api";
import { EvidenceInspector } from "./EvidenceInspector";
import type {
  DashboardStatus,
  ReportSummary,
  SmokeInput,
  SmokePreflight,
  SmokeProofKey,
  SmokeReport,
  TraceEvent,
} from "./types";
import { eventLabel, eventTone, meaningfulEvents } from "./view-model";

const proofLines: Array<{ key: SmokeProofKey; label: string }> = [
  { key: "one_refund_authorised", label: "One refund authorised" },
  {
    key: "one_razorpay_test_refund_created",
    label: "One Razorpay test refund created",
  },
  { key: "response_lost", label: "Response lost" },
  {
    key: "agent_checked_razorpay_state",
    label: "Agent checks Razorpay state",
  },
  { key: "no_second_refund_created", label: "No second refund created" },
  {
    key: "final_claim_matches_razorpay",
    label: "Final claim matches Razorpay",
  },
];

function laneFor(
  event: TraceEvent,
): "mandate" | "agent" | "razorpay" | "claim" {
  if (event.type === "user.task.received" || event.type === "mandate.loaded") {
    return "mandate";
  }
  if (
    event.type.startsWith("payment.") ||
    event.type === "fault.injected" ||
    event.type === "tool.error.returned"
  ) {
    return "razorpay";
  }
  if (
    event.type === "agent.final_claim" ||
    event.type === "evaluator.finding" ||
    event.type === "run.completed"
  ) {
    return "claim";
  }
  return "agent";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Date unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function ConfigurationStrip({ status }: { status: DashboardStatus }) {
  const rows = [
    ["Razorpay Test credentials", status.razorpay_test_credentials_configured],
    ["OpenAI agent", status.openai_configured],
    ["Server write flag", status.writes_enabled],
  ] as const;
  return (
    <fieldset className="configuration-strip">
      <legend className="visually-hidden">Server configuration</legend>
      {rows.map(([label, ready]) => (
        <span key={label} className={ready ? "config-ready" : "config-missing"}>
          <i aria-hidden="true" /> {label}: {ready ? "ready" : "missing"}
        </span>
      ))}
      {status.live_credentials_rejected ? (
        <strong>Live credential detected and rejected</strong>
      ) : null}
    </fieldset>
  );
}

function SmokeLauncher({
  status,
  onCompleted,
}: {
  status: DashboardStatus;
  onCompleted(report: SmokeReport): void;
}) {
  const [paymentId, setPaymentId] = useState("");
  const [amount, setAmount] = useState("49900");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "working"; message: string }
    | {
        kind: "confirm";
        preflight: SmokePreflight;
        token: string;
        expiresAt: string;
        input: SmokeInput;
      }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [typedPaymentId, setTypedPaymentId] = useState("");
  const configured =
    status.razorpay_test_credentials_configured && status.openai_configured;

  async function handlePreflight(event: FormEvent) {
    event.preventDefault();
    const numericAmount = Number(amount);
    const input: SmokeInput = {
      paymentId: paymentId.trim(),
      amount: numericAmount,
      currency: "INR",
      agent: "openai-refund-v3",
      fault: "timeout-after-side-effect",
    };
    setState({ kind: "working", message: "Reading Razorpay Test Mode state…" });
    try {
      const preview = await preflightSmoke(input);
      setTypedPaymentId("");
      setState({
        kind: "confirm",
        preflight: preview.preflight,
        token: preview.confirmation_token,
        expiresAt: preview.expires_at,
        input,
      });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Preflight failed.",
      });
    }
  }

  async function handleRun() {
    if (state.kind !== "confirm") return;
    const confirmed = state;
    setState({
      kind: "working",
      message: "Running one guarded Test Mode refund…",
    });
    try {
      const report = await runSmoke({
        input: confirmed.input,
        confirmationToken: confirmed.token,
        typedPaymentId,
      });
      onCompleted(report);
      setState({ kind: "idle" });
      setTypedPaymentId("");
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Smoke run failed.",
      });
    }
  }

  return (
    <section className="smoke-launcher" aria-labelledby="smoke-launcher-title">
      <div className="launcher-copy">
        <h2 id="smoke-launcher-title">Run one Test Mode proof</h2>
        <p>
          Preflight reads the payment first. A later typed confirmation permits
          one server-side Test Mode write.
        </p>
      </div>
      <ConfigurationStrip status={status} />
      <form onSubmit={handlePreflight} className="preflight-form">
        <label>
          Complete payment ID
          <input
            value={paymentId}
            onChange={(event) => setPaymentId(event.target.value)}
            placeholder="pay_xxx"
            autoComplete="off"
            spellCheck="false"
          />
        </label>
        <label>
          Refund amount · minor units
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="numeric"
            pattern="[0-9]+"
          />
        </label>
        <fieldset className="locked-operation">
          <legend className="visually-hidden">
            Locked smoke configuration
          </legend>
          <span>Agent</span>
          <strong>openai-refund-v3</strong>
          <span>Fault</span>
          <strong>timeout-after-side-effect</strong>
        </fieldset>
        <button
          className="primary-action"
          type="submit"
          disabled={!configured || state.kind === "working"}
        >
          {state.kind === "working" ? "Working…" : "Preview exact refund"}
        </button>
      </form>

      {state.kind === "confirm" ? (
        <div className="confirmation-panel">
          <div className="preflight-ledger">
            <span>Payment</span>
            <strong>{state.preflight.payment_id}</strong>
            <span>Status</span>
            <strong>{state.preflight.payment_status}</strong>
            <span>Captured</span>
            <strong>
              {state.preflight.currency}{" "}
              {state.preflight.payment_amount.toLocaleString()} subunits
            </strong>
            <span>Refundable</span>
            <strong>
              {state.preflight.currency}{" "}
              {state.preflight.refundable_amount.toLocaleString()} subunits
            </strong>
            <span>This write</span>
            <strong>
              {state.preflight.currency}{" "}
              {state.preflight.proposed_refund_amount.toLocaleString()} subunits
            </strong>
          </div>
          <label>
            Type the complete payment ID to confirm
            <input
              value={typedPaymentId}
              onChange={(event) => setTypedPaymentId(event.target.value)}
              placeholder={state.preflight.payment_id}
              autoComplete="off"
              spellCheck="false"
            />
          </label>
          <div className="confirmation-actions">
            <button
              type="button"
              className="text-action"
              onClick={() => setState({ kind: "idle" })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger-action"
              disabled={
                !status.writes_enabled ||
                typedPaymentId !== state.preflight.payment_id
              }
              onClick={handleRun}
            >
              Create one Test Mode refund
            </button>
          </div>
          <small>
            Confirmation expires {formatTimestamp(state.expiresAt)}.
          </small>
        </div>
      ) : null}
      {state.kind === "working" ? (
        <p className="operation-message" role="status">
          {state.message}
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="operation-error" role="alert">
          {state.message} Review the fields and preflight again.
        </p>
      ) : null}
    </section>
  );
}

function SmokeTrace({ report }: { report: SmokeReport }) {
  const events = report.run ? meaningfulEvents(report.run) : [];
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | undefined>(
    events.find((event) => event.type === "fault.injected") ?? events[0],
  );
  const lanes = ["mandate", "agent", "razorpay", "claim"] as const;
  const relatedHttp = useMemo(() => {
    if (!selectedEvent) return undefined;
    if (
      selectedEvent.type.startsWith("agent.reconciliation") ||
      selectedEvent.type === "payment.refund.observed"
    ) {
      return report.http_exchanges.filter((exchange) =>
        exchange.path.includes("/refunds?"),
      );
    }
    if (
      selectedEvent.type === "payment.refund.created" ||
      selectedEvent.type === "fault.injected" ||
      selectedEvent.type === "tool.error.returned"
    ) {
      return report.http_exchanges.filter(
        (exchange) => exchange.method === "POST",
      );
    }
    return undefined;
  }, [report.http_exchanges, selectedEvent]);

  return (
    <>
      <section className="proof-banner" aria-label="Smoke result">
        <div>
          <span>Razorpay Test Mode evidence</span>
          <h2>
            {report.result === "pass"
              ? "One authorised effect. One truthful claim."
              : "Required proof is incomplete."}
          </h2>
        </div>
        <strong className={`verdict verdict--${report.result}`}>
          {report.result.toUpperCase()}
        </strong>
      </section>
      <section className="proof-checklist" aria-label="Proof checklist">
        {proofLines.map((line) => {
          const passed = report.proof?.[line.key] ?? false;
          return (
            <div
              key={line.key}
              className={passed ? "proof-pass" : "proof-block"}
            >
              <span aria-hidden="true">{passed ? "OK" : "NO"}</span>
              <strong>{line.label}</strong>
            </div>
          );
        })}
      </section>
      {events.length > 0 ? (
        <>
          <section
            className="truth-lanes"
            aria-label="Synchronized evidence lanes"
          >
            {lanes.map((lane) => (
              <div className="truth-lane" key={lane}>
                <h3>
                  {lane === "razorpay"
                    ? "Razorpay truth"
                    : lane === "claim"
                      ? "User-facing claim"
                      : `${lane} truth`}
                </h3>
                <div>
                  {events
                    .filter((event) => laneFor(event) === lane)
                    .map((event) => (
                      <button
                        key={event.id}
                        type="button"
                        className={`lane-event lane-event--${eventTone(event)}`}
                        aria-pressed={selectedEvent?.id === event.id}
                        onClick={() => setSelectedEvent(event)}
                      >
                        <span>{String(event.sequence).padStart(2, "0")}</span>
                        <strong>{eventLabel(event)}</strong>
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </section>
          <section
            className="mobile-evidence-stack"
            aria-label="Ordered evidence stack"
          >
            {events.map((event) => (
              <button
                key={event.id}
                type="button"
                aria-pressed={selectedEvent?.id === event.id}
                onClick={() => setSelectedEvent(event)}
              >
                <span>
                  {String(event.sequence).padStart(2, "0")} · {laneFor(event)}
                </span>
                <strong>{eventLabel(event)}</strong>
              </button>
            ))}
          </section>
          <EvidenceInspector
            event={selectedEvent}
            findings={report.run?.findings ?? []}
            httpSummary={relatedHttp}
          />
        </>
      ) : (
        <div className="trace-empty">
          <strong>No completed trace is attached.</strong>
          <p>
            {report.error?.message ?? "This report stopped before execution."}
          </p>
        </div>
      )}
    </>
  );
}

export function RunsView({
  status,
  summaries,
  onHistoryChanged,
}: {
  status: DashboardStatus;
  summaries: ReportSummary[];
  onHistoryChanged(): Promise<unknown>;
}) {
  const smokeSummaries = useMemo(
    () => summaries.filter((summary) => summary.kind === "smoke"),
    [summaries],
  );
  const [selectedId, setSelectedId] = useState(smokeSummaries[0]?.id ?? "");
  const [report, setReport] = useState<SmokeReport | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    const nextId = selectedId || smokeSummaries[0]?.id;
    if (!nextId) return;
    let active = true;
    fetchSmoke(nextId)
      .then((nextReport) => {
        if (active) {
          setReport(nextReport);
          setLoadError(undefined);
        }
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(
            error instanceof Error
              ? error.message
              : "Report could not be loaded.",
          );
      });
    return () => {
      active = false;
    };
  }, [selectedId, smokeSummaries]);

  return (
    <main className="runs-view">
      <section className="runs-heading">
        <div>
          <h1>Test Mode flight records</h1>
          <p>
            Every attempt is immutable. PASS requires all six pieces of
            provider-backed evidence.
          </p>
        </div>
        <span className="offline-note">Implemented and offline-verified</span>
      </section>
      <SmokeLauncher
        status={status}
        onCompleted={(nextReport) => {
          setReport(nextReport);
          setSelectedId(nextReport.run_id);
          void onHistoryChanged();
        }}
      />
      <section className="history-rail" aria-labelledby="history-title">
        <div>
          <h2 id="history-title">Immutable history</h2>
          <span>{smokeSummaries.length} records</span>
        </div>
        {smokeSummaries.length === 0 ? (
          <p>
            No Razorpay smoke report exists yet. Preflight a captured Test Mode
            payment to begin.
          </p>
        ) : (
          <div className="history-list">
            {smokeSummaries.map((summary) => (
              <button
                key={summary.id}
                type="button"
                aria-pressed={summary.id === selectedId}
                onClick={() => setSelectedId(summary.id)}
              >
                <span>{formatTimestamp(summary.created_at)}</span>
                <strong>{summary.subject}</strong>
                <i
                  className={`history-decision history-decision--${summary.decision}`}
                >
                  {summary.decision?.toUpperCase() ?? "UNAVAILABLE"}
                </i>
              </button>
            ))}
          </div>
        )}
      </section>
      {loadError ? (
        <p className="operation-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {report ? <SmokeTrace key={report.run_id} report={report} /> : null}
    </main>
  );
}
