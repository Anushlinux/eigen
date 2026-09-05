import { randomUUID } from "node:crypto";
import { FINANCIAL_EVALUATOR_VERSION } from "@eigen/core";
import { canonicalJson } from "@eigen/external-runner";
import type { CodingAgentProvider } from "./coding-agent.js";
import type { EvaluationProvider } from "./evaluation.js";
import { redact } from "./security.js";
import { appendEvent, type PlatformService } from "./service.js";
import { type Job, PlatformError, type PlatformState } from "./types.js";

export interface WorkerDependencies {
  service: PlatformService;
  coding: CodingAgentProvider;
  evaluator: EvaluationProvider;
  nextId?: () => string;
  now?: () => Date;
}
export function createPlatformWorker(deps: WorkerDependencies) {
  const id = deps.nextId ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const store = deps.service.deps.store;
  const stamp = () => now().toISOString();
  const active = new Map<string, AbortController>();
  function requireLease(state: PlatformState, job: Job, lease: string) {
    const current = state.jobs[job.id];
    if (
      !current ||
      current.lease !== lease ||
      current.status !== "running" ||
      current.cancelRequested ||
      state.projects[job.projectId]?.integration === "disconnected"
    )
      throw new PlatformError(409, "Job was cancelled or its lease expired.");
    return current;
  }
  async function claim() {
    return store.transaction((state) => {
      for (const job of Object.values(state.jobs)) {
        if (
          job.status === "running" &&
          job.leaseUntil &&
          job.leaseUntil < stamp()
        ) {
          job.lease = null;
          if (!job.cancelRequested && job.candidate && job.attempts < 2)
            job.status = "queued";
          else {
            job.status = job.cancelRequested ? "cancelled" : "incomplete";
            job.completedAt = stamp();
            job.error =
              "Worker interrupted. Start a new job to retry; saved evidence is preserved.";
          }
        }
      }
      const job = Object.values(state.jobs)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .find(
          (job) =>
            job.status === "queued" &&
            !job.cancelRequested &&
            state.projects[job.projectId]?.integration !== "disconnected" &&
            !Object.values(state.jobs).some(
              (other) =>
                other.projectId === job.projectId && other.status === "running",
            ),
        );
      if (!job) return null;
      job.status = "running";
      job.lease = id();
      job.leaseUntil = new Date(now().getTime() + 60000).toISOString();
      job.startedAt = stamp();
      job.attempts++;
      appendEvent(
        state,
        job,
        "started",
        `${job.kind === "integration" ? "Integration" : job.kind === "repair" ? "Repair" : "Evaluation"} job started for commit ${job.commit.slice(0, 12)}.`,
        id(),
        stamp(),
      );
      const project = state.projects[job.projectId];
      if (job.kind === "integration" && project)
        project.integration = "working";
      return job;
    });
  }
  async function tick() {
    const job = await claim();
    if (!job?.lease) return false;
    const lease = job.lease;
    const controller = new AbortController();
    active.set(job.id, controller);
    const deadline = setTimeout(
      () => controller.abort(new Error("Job time limit reached.")),
      job.kind === "evaluation" ? 600000 : 300000,
    );
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void store
        .transaction((state) => {
          const current = requireLease(state, job, lease);
          current.leaseUntil = new Date(now().getTime() + 60000).toISOString();
        })
        .catch(() => controller.abort())
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 10000);
    const fence = async () => {
      controller.signal.throwIfAborted();
      await store.read((state) => requireLease(state, job, lease));
    };
    const event = async (stage: string, message: string) => {
      await store.transaction((state) => {
        const current = requireLease(state, job, lease);
        appendEvent(state, current, stage, message, id(), stamp());
      });
    };
    try {
      if (job.evaluatorVersion !== FINANCIAL_EVALUATOR_VERSION)
        throw new PlatformError(
          409,
          "The evaluator version changed after this job was queued. Start a new evaluation explicitly.",
        );
      const context = await store.read((state) => ({
        project: state.projects[job.projectId],
        tests: job.testVersionIds.map((versionId) => state.tests[versionId]),
        evidence: job.comparisonRunId
          ? (state.runs[job.comparisonRunId]?.report ?? null)
          : null,
      }));
      if (
        !context.project ||
        context.tests.some((test) => !test || test.projectId !== job.projectId)
      )
        throw new PlatformError(409, "Frozen job inputs are unavailable.");
      const project = context.project;
      const github = deps.service.deps.github;
      if (!github) throw new PlatformError(503, "GitHub is not configured.");
      await deps.service.accessible(job.ownerId, project.repository);
      await fence();
      let report = job.candidate?.report ?? null;
      let reportCommit = job.commit;
      if (job.kind === "evaluation") {
        await event(
          "reading",
          "Downloading the exact source commit from GitHub.",
        );
        const source = await github.snapshot(project.repository, job.commit);
        report = await deps.evaluator.evaluate({
          files: source.files,
          scenarios: context.tests.map((test) => {
            if (!test) throw new PlatformError(409, "Missing test version.");
            return test.scenario;
          }),
          model: job.model,
          id: job.id,
          signal: controller.signal,
          event,
        });
      } else {
        let candidate = job.candidate;
        if (!candidate) {
          await event(
            "reading",
            "Reading repository source and the frozen evaluation inputs.",
          );
          const source = await github.snapshot(project.repository, job.commit);
          const result = await deps.coding.run({
            kind: job.kind,
            files: source.files,
            evidence: context.evidence,
            scenarios: context.tests.map((test) => {
              if (!test) throw new PlatformError(409, "Missing test version.");
              return test.scenario;
            }),
            model: job.model,
            id: job.id,
            signal: controller.signal,
            event,
          });
          await fence();
          if (result.needsConfiguration)
            throw new PlatformError(422, result.summary);
          const changes = Object.fromEntries(
            Object.entries(result.files).filter(
              ([path, content]) => source.files[path] !== content,
            ),
          );
          if (Object.keys(changes).length === 0)
            throw new PlatformError(
              422,
              "The coding agent did not produce an integration or repair change. Inspect its activity before retrying.",
            );
          const sameFiles =
            result.verifiedFiles !== null &&
            canonicalJson({ ...source.files, ...changes }) ===
              canonicalJson(result.verifiedFiles);
          const completeEvidence = Boolean(
            result.report &&
              result.report.runs.length === context.tests.length &&
              result.report.runs.every(
                ({ report }) => report.final_claim_source === "agent",
              ) &&
              result.report.provenance.model_configuration.verified,
          );
          candidate = {
            files: changes,
            summary: result.summary,
            verified:
              sameFiles &&
              completeEvidence &&
              (job.kind === "integration" ||
                result.report?.decision === "allow"),
            report: sameFiles ? result.report : null,
          };
          await store.transaction((state) => {
            if (candidate)
              requireLease(state, job, lease).candidate = candidate;
          });
        }
        await fence();
        await deps.service.accessible(job.ownerId, project.repository);
        await fence();
        await event(
          "publishing",
          "Publishing the candidate branch and linked pull request.",
        );
        const branch = `eigen/${job.kind}/${job.id}`;
        const details = `${deps.service.deps.origin}/projects/${project.id}/agent`;
        const body = `${candidate.summary}\n\nBase commit: \`${job.commit}\`\n\n${candidate.verified ? (job.kind === "integration" ? "Integration execution verified. Financial test outcomes are recorded separately." : "The unchanged selected tests passed for this candidate.") : "Verification is incomplete or failed. This is a draft PR and is not a passing result."}\n\n${candidate.report ? `Selected tests: ${candidate.report.runs.filter(({ report }) => report.result === "pass").length}/${candidate.report.runs.length} passed. Simulated payments only.` : "No completed candidate evaluation is available."}\n\n[Agent activity and evidence](${details})\n\nReview and merge manually. Eigen does not deploy customer applications.`;
        const published = await github.publish(project.repository, {
          branch,
          baseBranch: project.branch,
          baseCommit: job.commit,
          files: candidate.files,
          title:
            job.kind === "integration"
              ? "Connect refund agent to Eigen evaluations"
              : "Repair the refund-agent failure verified by Eigen",
          body,
          draft: !candidate.verified,
        });
        await fence();
        report = candidate.report;
        reportCommit = published.commit;
        await store.transaction((state) => {
          requireLease(state, job, lease);
          const prId = job.id;
          state.pullRequests[prId] = {
            id: prId,
            ownerId: job.ownerId,
            projectId: job.projectId,
            jobId: job.id,
            number: published.number,
            url: published.url,
            baseCommit: job.commit,
            candidateCommit: published.commit,
            branch,
            kind: job.kind as "integration" | "repair",
            status: published.status ?? "open",
            draft: published.draft ?? !candidate.verified,
            verified: candidate.verified,
            changedFiles: Object.keys(candidate.files),
            summary: candidate.summary,
          };
          const savedProject = state.projects[job.projectId];
          if (job.kind === "integration" && savedProject)
            savedProject.integration = candidate.verified
              ? "ready"
              : "needs_configuration";
          requireLease(state, job, lease).pullRequestId = prId;
        });
        await event(
          "published",
          `Pull request #${published.number} opened${candidate.verified ? " with verification evidence" : " as a draft requiring verification"}.`,
        );
      }
      await fence();
      let runId: string | null = null;
      await store.transaction((state) => {
        const current = requireLease(state, job, lease);
        if (report) {
          if (JSON.stringify(report).length > 12000000)
            throw new PlatformError(
              422,
              "Run evidence exceeds the pilot storage limit.",
            );
          runId = job.id;
          state.runs[runId] = {
            id: runId,
            ownerId: job.ownerId,
            projectId: job.projectId,
            jobId: job.id,
            commit: reportCommit,
            testVersionIds: job.testVersionIds,
            model: job.model,
            createdAt: stamp(),
            report,
          };
        }
        if (job.kind === "evaluation" && report && job.pullRequestId) {
          const pr = state.pullRequests[job.pullRequestId];
          const original = pr ? state.jobs[pr.jobId] : undefined;
          if (pr?.candidateCommit === reportCommit) {
            const sameTests =
              !original ||
              (original.model === job.model &&
                canonicalJson([...original.testVersionIds].sort()) ===
                  canonicalJson([...job.testVersionIds].sort()));
            const executed =
              report.runs.length === job.testVersionIds.length &&
              report.runs.every(
                ({ report }) => report.final_claim_source === "agent",
              ) &&
              report.provenance?.model_configuration.verified === true;
            if (sameTests)
              pr.verified =
                executed &&
                (pr.kind === "integration" || report.decision === "allow");
            const savedProject = state.projects[job.projectId];
            if (
              pr.kind === "integration" &&
              pr.verified &&
              savedProject &&
              savedProject.integration !== "disconnected"
            )
              savedProject.integration = "ready";
          }
        }
        current.status =
          job.kind === "evaluation" || current.candidate?.verified
            ? "completed"
            : "incomplete";
        current.completedAt = stamp();
        current.leaseUntil = null;
        appendEvent(
          state,
          current,
          "finished",
          current.status === "completed"
            ? "Job completed. Inspect the recorded results and linked changes."
            : "Draft changes are available; verification is incomplete or failed.",
          id(),
          stamp(),
        );
        // Source changes are retained only while publishing/recovering; PR and report carry final provenance.
        delete current.candidate;
      });
      if (report && runId) {
        try {
          await github.check(
            project.repository,
            reportCommit,
            report.decision === "allow" ? "success" : "failure",
            `${deps.service.deps.origin}/projects/${project.id}/runs/${runId}`,
            `${report.runs.filter(({ report }) => report.result === "pass").length}/${report.runs.length} selected tests passed. Payments were simulated.`,
          );
        } catch {
          await store.transaction((state) =>
            appendEvent(
              state,
              job,
              "github",
              "Evidence is saved. GitHub check publication failed; reconnect access and rerun to publish it.",
              id(),
              stamp(),
            ),
          );
        }
      }
    } catch (error) {
      await store.transaction((state) => {
        const current = state.jobs[job.id];
        if (!current || current.lease !== lease) return;
        current.status = current.cancelRequested
          ? "cancelled"
          : controller.signal.aborted
            ? "incomplete"
            : "failed";
        current.error = controller.signal.aborted
          ? "Execution stopped at its limit or was interrupted. No completed verification is claimed."
          : error instanceof PlatformError
            ? redact(error.message)
            : "The job could not finish. Check provider access and the recorded activity before retrying.";
        current.completedAt = stamp();
        current.leaseUntil = null;
        const savedProject = state.projects[job.projectId];
        if (
          job.kind === "integration" &&
          savedProject &&
          savedProject.integration !== "disconnected"
        )
          savedProject.integration = "needs_configuration";
        appendEvent(
          state,
          current,
          current.status,
          current.error,
          id(),
          stamp(),
        );
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      active.delete(job.id);
    }
    return true;
  }
  return {
    tick,
    async shutdown() {
      for (const controller of active.values()) controller.abort();
    },
  };
}
