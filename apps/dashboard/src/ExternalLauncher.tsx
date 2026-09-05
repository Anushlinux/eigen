import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchExternalConfig,
  fetchExternalJob,
  fetchExternalJobs,
  startExternalJob,
} from "./api";
import type { ExternalJob, ExternalJobConfig } from "./external-job-types";

type Submission = { suite_id: string; trials: number; submission_id: string };
const storageKey = "eigen.external.pending-submission";
const activeJob = (job: ExternalJob) =>
  job.status === "queued" || job.status === "running";
function savedSubmission(): Submission | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (
      value &&
      typeof value.suite_id === "string" &&
      typeof value.submission_id === "string" &&
      Number.isInteger(value.trials) &&
      value.trials >= 1 &&
      value.trials <= 3
    )
      return value;
  } catch {
    /* Session storage may be unavailable. Server deduplication still applies. */
  }
  return undefined;
}
function remember(value?: Submission) {
  try {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* Keep the in-memory submission when storage is unavailable. */
  }
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The local server could not be reached.";
}

export function ExternalLauncher({
  onCompleted,
}: {
  onCompleted(suiteId: string): Promise<void> | void;
}) {
  const [config, setConfig] = useState<ExternalJobConfig>();
  const [suiteId, setSuiteId] = useState("");
  const [trials, setTrials] = useState(1);
  const [job, setJob] = useState<ExternalJob>();
  const [pending, setPending] = useState<Submission | undefined>(
    savedSubmission,
  );
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [pollError, setPollError] = useState<string>();
  const submittingRef = useRef(false);
  const followJob = useRef<string | undefined>(undefined);
  const openedJob = useRef<string | undefined>(undefined);
  const completion = useRef(onCompleted);
  completion.current = onCompleted;

  const accept = useCallback((next: ExternalJob) => {
    setJob(next);
    setPending((previous) => {
      if (previous?.submission_id === next.submission_id) {
        remember();
        return undefined;
      }
      return previous;
    });
    if (activeJob(next)) followJob.current = next.id;
    if (
      next.status === "completed" &&
      next.result_suite_id &&
      followJob.current === next.id &&
      openedJob.current !== next.id
    ) {
      openedJob.current = next.id;
      Promise.resolve(completion.current(next.result_suite_id)).catch(
        (reason) => {
          setError(
            `The evaluation completed, but its results could not be opened: ${message(reason)}`,
          );
        },
      );
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    Promise.all([fetchExternalConfig(), fetchExternalJobs()])
      .then(([nextConfig, jobs]) => {
        if (!mounted) return;
        setConfig(nextConfig);
        setTrials(nextConfig.default_trials ?? 1);
        setSuiteId(nextConfig.suites[0]?.id ?? "");
        const saved = savedSubmission();
        const nextJob =
          jobs.find((item) => item.submission_id === saved?.submission_id) ??
          jobs.find(activeJob) ??
          jobs[0];
        if (nextJob) {
          if (saved?.submission_id === nextJob.submission_id)
            followJob.current = nextJob.id;
          accept(nextJob);
        }
      })
      .catch((reason) => {
        if (mounted) setError(message(reason));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [accept]);

  useEffect(() => {
    if (!job || !activeJob(job)) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await fetchExternalJob(job.id);
        if (!mounted) return;
        setPollError(undefined);
        accept(next);
        if (activeJob(next)) timer = setTimeout(poll, 1000);
      } catch (reason) {
        if (!mounted) return;
        setPollError(
          `Progress is temporarily unavailable: ${message(reason)} Checking again; no evaluation will be resubmitted.`,
        );
        timer = setTimeout(poll, 3000);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [job, accept]);

  async function submit() {
    if (submittingRef.current || (job && activeJob(job))) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    const input = pending ?? {
      suite_id: suiteId,
      trials,
      submission_id: crypto.randomUUID(),
    };
    setPending(input);
    remember(input);
    try {
      const next = await startExternalJob(input);
      followJob.current = next.id;
      accept(next);
    } catch (reason) {
      setError(
        `${message(reason)} Retry uses the same submission ID to prevent a duplicate evaluation.`,
      );
      try {
        const jobs = await fetchExternalJobs();
        const found =
          jobs.find((item) => item.submission_id === input.submission_id) ??
          jobs.find(activeJob);
        if (found) accept(found);
      } catch {
        /* Leave the same pending submission available for explicit retry. */
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const selectedSuite = config?.suites.find(
    (item) => item.id === (pending?.suite_id ?? suiteId),
  );
  const busy = submitting || Boolean(job && activeJob(job));
  return (
    <section className="external-launcher" aria-labelledby="launch-title">
      <header>
        <h2 id="launch-title">Run evaluation</h2>
        <p>
          Test the configured refund application with simulated payments and
          live OpenAI inference.
        </p>
      </header>
      {loading ? <p role="status">Reading evaluation configuration…</p> : null}
      {config ? (
        <>
          <dl className="external-launch-config">
            <div>
              <dt>Application</dt>
              <dd>{config.application.id}</dd>
            </div>
            <div>
              <dt>Configured model</dt>
              <dd>{config.model ?? "Not configured"}</dd>
            </div>
            <div>
              <dt>Payment environment</dt>
              <dd>Simulated payments</dd>
            </div>
            {config.timeout_ms ? (
              <div>
                <dt>Time limit per run</dt>
                <dd>{config.timeout_ms / 1000} seconds</dd>
              </div>
            ) : null}
          </dl>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="external-selectors">
              <label>
                Reviewed suite
                <select
                  value={pending?.suite_id ?? suiteId}
                  disabled={busy || Boolean(pending)}
                  onChange={(event) => setSuiteId(event.target.value)}
                >
                  {config.suites.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Trials per scenario
                <select
                  value={pending?.trials ?? trials}
                  disabled={busy || Boolean(pending)}
                  onChange={(event) => setTrials(Number(event.target.value))}
                >
                  {[1, 2, 3].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p>
              {selectedSuite?.scenarios.length ?? 0} scenarios ×{" "}
              {pending?.trials ?? trials}{" "}
              {(pending?.trials ?? trials) === 1 ? "trial" : "trials"} ={" "}
              {(selectedSuite?.scenarios.length ?? 0) *
                (pending?.trials ?? trials)}{" "}
              application runs. Inference uses your configured OpenAI account.
            </p>
            {selectedSuite ? (
              <details>
                <summary>Reviewed scenarios</summary>
                <ol>
                  {selectedSuite.scenarios.map((scenario) => (
                    <li key={scenario.id}>{scenario.name}</li>
                  ))}
                </ol>
              </details>
            ) : null}
            <button
              className="primary-button"
              type="submit"
              disabled={busy || !config.available || !selectedSuite}
            >
              {submitting
                ? "Submitting evaluation…"
                : job && activeJob(job)
                  ? "Evaluation in progress"
                  : pending
                    ? "Retry submission"
                    : "Run evaluation"}
            </button>
          </form>
          {!config.available ? (
            <p role="alert">
              {config.unavailable_reason ??
                "Evaluation is unavailable. Check the local application build and OpenAI configuration."}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="external-evidence-note" role="alert">
          {error}
        </p>
      ) : null}
      {job ? (
        <section
          className="external-job"
          aria-label="Evaluation job"
          aria-live="polite"
        >
          <h3>
            {job.status === "completed"
              ? "Evaluation completed"
              : job.status === "failed"
                ? "Evaluation could not finish"
                : job.status === "queued"
                  ? "Evaluation queued"
                  : "Evaluation running"}
          </h3>
          <p>
            {job.progress.completed} of {job.progress.total} trials complete
            {activeJob(job) && job.progress.scenario_id
              ? ` · ${job.progress.scenario_id} · Trial ${job.progress.trial}`
              : ""}
          </p>
          {job.status === "completed" ? (
            <p>
              {job.decision === "block"
                ? "The saved suite contains failed trials. A completed test can find application violations or execution errors."
                : "The application passed these trials."}
            </p>
          ) : null}
          {job.error ? (
            <p>
              <strong>{job.error.code}</strong>: {job.error.message}
            </p>
          ) : null}
          {job.result_suite_id ? (
            <button
              type="button"
              onClick={() =>
                void Promise.resolve(
                  onCompleted(job.result_suite_id as string),
                ).catch((reason) => setError(message(reason)))
              }
            >
              Open saved results
            </button>
          ) : null}
          {pollError ? <p role="alert">{pollError}</p> : null}
        </section>
      ) : null}
    </section>
  );
}
