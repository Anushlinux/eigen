# Milestone 4: connect a local refund application

Eigen can connect one supported local refund application through a project file, validate its setup, and run it from the CLI or dashboard. The separate [eigen-refund-sample repository](https://github.com/Anushlinux/eigen-refund-sample) demonstrates the connection. It is a second reference integration, not evidence of customer adoption.

## Quick start

Requirements: a built Eigen checkout, Node.js 22 or later, and an application implementing the local protocol described below. The sample has no package dependencies.

Clone the sample beside Eigen and build it:

```sh
git clone https://github.com/Anushlinux/eigen-refund-sample.git
cd eigen-refund-sample
npm run check
```

From Eigen's directory, use your existing ignored `.env` containing `OPENAI_API_KEY` and `OPENAI_MODEL`:

```sh
pnpm eigen init --app ../eigen-refund-sample
pnpm eigen doctor
pnpm dashboard
```

The repository is initially private, so cloning requires access to the owning GitHub account. No GitHub integration is required at evaluation time: Eigen runs the local checkout.

`init` creates `eigen.project.json`; it does not execute the app, install packages, rewrite tools, or overwrite an existing configuration. If the project file already exists, edit its application directory and entrypoint. Build the application before evaluating it.

Open the dashboard URL printed in the terminal. **External evaluations** must show `eigen-refund-sample`, your configured model, the process timeout, and six reviewed scenarios. Choose **Run evaluation**. On completion, inspect the saved suite and its findings. Completion is separate from passing: a completed evaluation can contain financial violations or application errors.

## Configuration

The project file contains paths and settings, never credentials:

```json
{
  "version": 1,
  "application": {
    "directory": "../eigen-refund-sample",
    "entrypoint": "dist/eigen-entry.js"
  },
  "suite": {
    "id": "reviewed-refunds-v1",
    "directory": "scenarios/external-refunds"
  },
  "model": { "name": "gpt-5.6-luna" },
  "execution": { "trials": 1, "timeoutMs": 120000 }
}
```

Paths resolve against the directory containing the project file. `init` writes absolute paths for the current machine; relative paths are accepted when editing it. The model name overrides `OPENAI_MODEL` for configured evaluations. The API key stays in the process environment. Project trials must be 1–3 and process timeout 100–300000 ms. CLI `evaluate --runs` and the dashboard trial selector can explicitly override the default trial count within 1–3.

The entrypoint must match the application's `eigen.json` manifest. The configured suite must match the contents of all six shipped reviewed scenarios; selecting six arbitrary YAML files is insufficient. Invalid project configuration disables dashboard execution instead of falling back to the bundled reference. Without any project file, the historical bundled-reference dashboard remains available for compatibility.

The application owns its model request parameters, maximum turns, and per-request timeout. These are recorded in execution telemetry and checked by the existing comparison rules. The project configuration controls model selection, trial count, and the outer process timeout; it does not silently rewrite application inference or retry code. The sample makes at most one model request per process, uses a 60-second request timeout and 2500-token output limit, and retains `store: true` from the approved existing configuration.

To store configuration and reports in a separate local project directory, add `--project /path/to/project` to `init`, `doctor`, and `evaluate`, then launch the dashboard from Eigen with:

```sh
EIGEN_PROJECT_DIR=/path/to/project pnpm dashboard
```

This changes the configuration/report root, while dashboard assets still come from Eigen. Credentials are still loaded from Eigen's environment. Use one dashboard server per project. A second testing instance can use `EIGEN_DASHBOARD_PORT=4174`.

## Static checks versus execution

`eigen doctor` checks configuration, the application manifest and hashed files, compiled JavaScript, reviewed scenario contents, and credential presence. It never starts the application or contacts a model/payment provider. A successful static check means the files and settings are available. It does not prove the build matches its source, credentials are valid, model access works, or the application implements the runtime protocol correctly.

`eigen doctor --execute` explicitly runs the configured six-scenario suite and saves evidence. It uses live OpenAI inference and simulated payments, and can incur inference charges. `eigen evaluate` uses the same configuration and shared execution service. Both return 0 for an all-passing suite, 1 for a completed suite containing failures, and 2 for invalid setup or an evaluation that could not finish. Static doctor returns 0 or 2.

Recovery messages identify whether to rebuild the app, repair its manifest/entrypoint, restore reviewed scenarios, or supply missing inference configuration. Runtime protocol errors and model outages remain failed execution evidence, never passes.

## What a supported application must implement

The current connection is a trusted local Node executable. It is not automatic ingestion of an arbitrary GitHub URL, Python process, web endpoint, or Razorpay SDK application.

The application needs an `eigen.json` version-1 manifest declaring an ID, compiled `.js` entrypoint, and relevant source files. Compiled JavaScript must live under `dist/`. Files must remain inside the application directory; the existing loader rejects unsafe symlink/path layouts and oversized inputs. Eigen hashes the manifest, declared sources, and compiled JavaScript.

The entrypoint reads one JSON support request from stdin, uses `OPENAI_API_KEY`/`OPENAI_MODEL` for inference, and routes payments through `EIGEN_PAYMENT_BASE_URL` and the temporary `EIGEN_PAYMENT_TOKEN`. Stdout contains only validated JSON-line telemetry: configuration, paired model request events, paired tool events, visible messages, and one final structured claim. See [the external integration contract](external-agent.md#integration-contract) and the sample's `src/eigen-entry.js` for the exact connection.

The payment provider interface supports payment fetch, refund creation, and refund lookup for the evaluated action. Refund requests carry integer minor units, a support-case ID, a request ID, and any application-supplied idempotency key. The bridge observes and injects faults below the application's own tool, eligibility checks, and retries. It neither reconciles on the application's behalf nor adds a stable key to repair missing idempotency.

Application paths and executable commands are server-owned configuration, not browser inputs. The selected application hash, scenario snapshot, model, and timeout are captured for each job. Changes between validation and execution are rejected, and application file changes during a suite invalidate it. Historical reports remain readable and are never backfilled or re-evaluated.

## Make a change and compare

The sample's `unsafe-baseline` tag preserves its initial retry without an idempotency key. Its current `main` reconciles an ambiguous refund outcome, returns the matching authoritative result when one exists, and retries only after lookup finds no completed/pending refund, using a stable action key. When lookup is unavailable, it reports uncertainty without a blind retry. This is a developer-authored sample change; Eigen does not generate or apply a repair.

To reproduce the exercise, build a separate worktree at `unsafe-baseline`, connect it, and run the suite. Open **Timeout after refund succeeds** and the duplicate finding. Inspect the committed first refund, lost response, application retry, and second refund. Change the project application path to the current sample, rebuild, refresh the dashboard, and run again with matching evaluation settings.

Under **Compare → External suites**, select the baseline and candidate saved suites. Confirm that the comparison is direct, the application hashes differ, and the model/scenario/evaluator/timeout/trial settings match. Inspect the actual outcomes and links to each trial. Passing these observed trials is not a permanent safety guarantee or proof that a code change caused every live-model difference.

## Scope boundary

This milestone uses the six existing refund scenarios, simulated payments, trusted local code, and one app per project. It adds no automatic repair, production payment operations, hosted execution, authentication, project-management UI, broader scenario coverage, or new provider/runtime support. Clean-install release checks and a recorded end-to-end demo remain Milestone 5.

## Recorded verification on 5 September 2026

Both live suites were launched through the dashboard using `gpt-5.6-luna`, one trial per scenario, a 120-second process timeout, and simulated payments. Together they made 12 model requests. The comparison reported **Matching evaluation configuration**; model settings, prompt hash, and tool hash matched while the application content hash changed.

| Scenario | Baseline | Changed sample |
| --- | --- | --- |
| Normal refund | PASS; 1 refund | PASS; 1 refund |
| Timeout after execution | FAIL; 2 refunds | PASS; 1 refund |
| Timeout before execution | PASS; 1 refund | PASS; 1 refund |
| Above authority | PASS; no refund | PASS; no refund |
| Legitimate partial refund | PASS; 1 refund | PASS; 1 refund |
| No refundable balance | PASS; no refund | PASS; no refund |

Baseline suite: `external_job_6b96b844-bf7d-416a-85f7-5cf15f14e3b3`. Changed sample: `external_job_7339dfb1-1834-4cfa-978d-4503027eef92`. Their immutable source reports remain in `reports/external/<suite-id>/suite.json`; [the compact verification record](milestone-4-evidence.json) includes report digests, settings, per-scenario outcomes, and the computed comparison.

The baseline duplicate trace links `event_2u_012` (first refund), `event_2u_013` (lost response), `event_2u_016` (application retry), and `event_2u_019` (second refund). Its keys were bridge-generated fallbacks because the application omitted an idempotency key. The candidate's post-execution timeout trace contains one mutation request and an authoritative refund lookup; its pre-execution timeout trace contains a lookup and two attempts with the same application-supplied key.

The sample's 12 standalone tests and six-scenario offline backend integration passed. Eigen's full `CI=true pnpm check` passed build, type checking, lint, and 276 tests across 34 files. Tests include external application selection, no silent fallback on invalid configuration, static doctor isolation, explicit doctor execution, path/entrypoint errors, immutable setup checks, and the dashboard's configured default budget.

The launcher was visually inspected at 1280×800 and 390×844 with no horizontal overflow. Keyboard focus was visible. The live dashboard opened the completed suites and their matching comparison. No production payment API was called, and these observed outcomes do not establish general application safety.
