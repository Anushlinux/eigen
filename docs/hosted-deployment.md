# Repository-backed hosted Eigen

## Current delivery and release gate

The repository contains the project API, Neon-backed store, GitHub App provider, durable worker, E2B execution provider, OpenAI coding agent, and project UI. Local sign-in uses the existing Neon Auth configuration. Local reports remain available at `/local` and are never assigned to hosted users.

This is not yet a verified hosted release. The acceptance below requires a configured GitHub App, E2B account, Render deployment, and real runs against `Anushlinux/eigen-refund-sample`. Passing automated tests does not establish these external integrations.

## Runtime and ownership

The Render web service serves the React app and authenticated APIs. A separate Render background worker claims durable jobs from Neon. No agent runs in a web request. Both processes share the same database and token-encryption key. GitHub user tokens are encrypted with AES-256-GCM; the App private key remains in backend secrets. An expiring, single-use OAuth state and browser cookie bind GitHub connection to the initiating Neon user. The backend verifies the user's installation and repository access before connection, execution, and publication.

Each project, scenario version, suite, job, event, run, and PR has a durable identifier and owner. The API returns only owned records. Hosted startup requires authentication, an HTTPS public origin, and an invite list. The hosted deployment uses `EIGEN_AUTH_MODE=github`: Better Auth runs in Eigen's backend, with durable sessions and OAuth state in Neon. Existing user IDs and GitHub identity links are copied by additive migration 3 into separate `eigen_auth_*` tables; managed Neon Auth's tables and sessions stay unchanged. Invite by preserved user ID or verified email. Local development continues to use managed Neon Auth unless the mode is explicitly changed.

Migrations 1–2 create `eigen_*` tables and identity constraints. The invited-pilot store serializes short mutations with a Postgres advisory lock. It loads the pilot records into memory within each database transaction; network calls and execution happen outside that lock. This design is intended for a small pilot, not an unbounded multi-tenant workload. Move to row-scoped repositories and private object storage before increasing evidence volume substantially.

## Configure and deploy

1. Populate the secret settings listed in `.env.hosted.example`. Existing Neon login OAuth credentials are **not** the GitHub App credentials.
2. Register the GitHub App under **Anushlinux**, with repository **Contents: write**, **Pull requests: write**, **Checks: write**, and **Metadata: read**. Subscribe to `push`, `pull_request`, and `pull_request_review`, plus installation and repository-access changes. GitHub delivers installation events automatically for Apps. Initially install only on `Anushlinux/eigen-refund-sample`.
3. Set the App homepage to the final Render HTTPS origin, user authorization callback to `<origin>/api/github/callback`, installation setup to `<origin>/github/setup`, and webhook to `<origin>/api/github/webhook`. Leave **Request user authorization (OAuth) during installation** unchecked: Eigen's separate Connect GitHub flow creates the browser-bound state before authorization. Enable **Redirect on update**, keep **Expire user authorization tokens** checked, and leave **Device flow** unchecked. Save App ID, slug, private key, client ID, client secret, and webhook secret as backend configuration. Selected repositories are verified through GitHub; the installation callback does not trust a supplied installation ID.
4. For hosted sign-in, configure the separate GitHub OAuth app's callback as `<origin>/api/auth/login/callback/github`. Set its client ID/secret plus `EIGEN_AUTH_SECRET` and `EIGEN_AUTH_MODE=github` on the web service. Keep the managed Neon callback as an additional registered callback only if retaining local Neon sign-in. These login and repository-connection callbacks serve different purposes.
5. Configure `E2B_API_KEY` and `OPENAI_API_KEY`. The initial model is the existing `gpt-5.6-luna`; `EIGEN_CODING_MODEL` overrides the model for newly created projects. No payment-provider credentials are needed.
6. Use `render.yaml` from the implementation branch. It defines `eigen-web` and `eigen-worker`, shares runtime secrets through service references, and runs additive migrations before web deployment. Set `EIGEN_INVITED_USERS` and the exact HTTPS origin. Do not enable public sign-up access by removing the invite check.
7. Run `pnpm check`. Deploy web and worker, confirm `/health`, and perform the acceptance sequence below. A healthy web server means database access is ready; the Projects setup notice separately lists missing execution providers.

For local development after a build:

```sh
pnpm platform:migrate
pnpm platform:web
# Separate terminal, after all provider secrets are configured:
pnpm platform:worker
```

Use `http://127.0.0.1:4173/api/github/callback` for the separate local GitHub App authorization callback. Webhook-triggered tests require a reachable HTTPS deployment; loopback cannot receive GitHub deliveries.

Render background workers do not receive incoming requests; this worker polls Neon. See [Render background workers](https://render.com/docs/background-workers) and [Blueprint configuration](https://render.com/docs/blueprint-spec).

### Current hosted GitHub settings

The Eigen repository GitHub App and the Neon sign-in OAuth app have separate callbacks and credentials.

| Eigen GitHub App field | Value |
|---|---|
| Homepage | `https://eigen-web-dkcg.onrender.com/` |
| User authorization callback | `https://eigen-web-dkcg.onrender.com/api/github/callback` |
| Installation setup URL | `https://eigen-web-dkcg.onrender.com/github/setup` |
| Active webhook URL | `https://eigen-web-dkcg.onrender.com/api/github/webhook` |
| Webhook secret | Existing `GITHUB_WEBHOOK_SECRET` from the ignored `.env`, also configured in Render |

Repository permissions: Contents, Pull requests, and Checks **read and write**; Metadata **read-only**. Other permissions are not required for this pilot. Subscribe to Push, Pull request, and Pull request review events; installation and installation-repository events are automatic. Allow installation on any account for invited developers, then select only the intended repositories when installing.

The sign-in OAuth app's homepage is `https://eigen-web-dkcg.onrender.com/`. Its hosted authorization callback is `https://eigen-web-dkcg.onrender.com/api/auth/login/callback/github`. GitHub supports multiple registered redirect URIs; preserve `https://ep-crimson-smoke-axwt82cq.neonauth.c-4.us-east-2.aws.neon.tech/neondb/auth/callback/github` as an additional callback for the existing local managed-Neon flow. Do not register the repository GitHub App's `/api/github/callback` as the login callback. Use exact URI matching rather than wildcards.

Hosted sign-in goes from Eigen to GitHub and directly back to Eigen. Session lookup, refresh and sign-out use only Eigen's origin. The browser does not contact a Neon hostname. The private backend connects to Neon for persistence. Login uses `read:user` and `user:email`; repository permissions come from the separate GitHub App. State is stored in the database and bound to a signed secure browser cookie, with PKCE for the authorization-code exchange. API authentication checks durable sessions, so sign-out revokes the API bearer token. Provider tokens are encrypted at rest. Session cookies are Secure, HttpOnly and SameSite=Lax.

## Execution and evidence

A job freezes the source commit, test-version IDs, evaluator version, and model. Repair uses the failed run's commit, unchanged tests, and model. A worker refuses an old queued evaluator version after an incompatible upgrade. Queued automatic commits are coalesced, matching completed work is reused, and only one job per project runs at a time. Automatic runs are capped at 20 per project per UTC day. Fork PR execution is excluded.

Coding jobs have a five-minute total deadline, at most 20 model turns, and at most two verification attempts. Evaluation jobs have a ten-minute ceiling. Leases, heartbeats, cancellation, and publication recovery are durable. Interrupted execution is explicitly incomplete; a persisted candidate can resume publication using a deterministic branch name. Recovery verifies the published tree and parent against the candidate before attaching evidence. No hidden financial retry is used to make interrupted evidence look complete.

The coding agent edits and runs bounded commands in E2B. Only explicit file-tool changes are published. Source snapshots exclude credentials, workflow files, symbolic links, unsupported package configuration, and oversized files. The pilot supports public npm or pnpm dependencies with a committed lockfile. Installation disables lifecycle scripts; network is then disabled before application build/test execution. Packages needing install scripts, extra services, or private registries receive an actionable configuration error.

Every financial trial starts in a clean sandbox and checks reproducible build hashes. The application communicates through local sandbox proxies and authenticated SDK streams. The trusted worker forwards only fixed simulator and bounded Responses API requests. GitHub write credentials, database credentials, and the real OpenAI key are never placed in the repository sandbox. Successful inference is independently observed by the trusted proxy. Financial effects and judgments remain in the existing trusted evaluator.

The integration agent must retain application retry/refund policy, including known defects. A working integration can have failing financial results. Repair is an explicit separate action and compares the same tests. “Integrated” and “Passing” never mean deployed to production. Model interpretation of repository behavior still requires human PR review; automated checks cannot prove a generated adapter faithfully exercises every application path.

## Verification record

Record automated checks and live evidence separately in `docs/hosted-verification.md`. The isolated Neon migration check is reproducible with `scripts/verify-platform-database.mjs` and an explicit disposable branch hostname. The script verifies repeated migrations, concurrent writes, rollback, and persistence after reconnect, then removes its own receipts.

## Hosted acceptance (all required)

- [ ] An invited user signs in and selects `Anushlinux/eigen-refund-sample`.
- [ ] A real integration agent creates a GitHub PR visible on the owned project.
- [ ] The user saves a custom test and reviews an AI draft before saving it.
- [ ] An exact-commit evaluation shows a reproducible failure with evidence.
- [ ] Fix with agent opens a real repair PR with unchanged-test before/after results.
- [ ] PR updates and merges synchronize and trigger appropriate evaluations.
- [ ] Browser refresh and worker restart preserve project records and outcomes.
- [ ] A second user cannot read or mutate the project, credentials, or evidence.
- [ ] Revocation, signed webhook replay, interruption, cancellation, deadlines, stale heads, immutable tests, and sandbox isolation are verified against deployed providers.

Until these boxes have actual URLs, commit IDs, and observed outcomes, the hosted release remains incomplete.
