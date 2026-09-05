# Hosted workflow verification — 2026-09-05

## Automated checks

`pnpm check` passed with the Node 24 runtime: build, TypeScript, Biome, **41 test files and 334 tests**. Tests use controlled providers and simulated payments; they did not call GitHub, E2B, OpenAI, or Render as live providers. The loopback HTTP tests require a shell permitted to bind local ports.

New coverage includes OAuth browser/state binding and expiry, encrypted credentials, owner isolation, immutable scenario versions, exact-source jobs, frozen repair tests/model, webhook replay/forks, cancellation, expired leases, five-minute coding cancellation, revoked access before publication, actual GitHub App key format and repository filtering, changed publication recovery trees, sandbox subprocess credential isolation, locked offline builds, precise currency entry, and test editor identity/historical selection.

The transport test runs a real local application subprocess through the relay with controlled model/payment responses. This is stronger than a mocked function test, but is **not** proof of E2B network isolation or a real model execution.

## Live checks performed

- Tested migrations twice on a separate Neon branch created from production: `eigen-platform-verification`, ID `br-morning-frog-ax56ivf7`.
- Verified eight concurrent record writes, transaction rollback, and persistence after closing and reconnecting the database client. Requested deletion of only this temporary verification branch after the checks; Neon accepted it with pending state `storage_deleted`.
- The initial test exposed JSON string serialization in the Postgres adapter. Fixed it to use the driver's JSON parameter, added database constraints requiring JSON objects with matching record/owner identities, and repeated the test successfully.
- Applied the two additive migrations to the existing Eigen Neon database. No authentication tables, existing local reports, or reviewed scenarios were changed by these migrations.
- Restarted the local web server, retained working Neon sign-in, and observed the actual authenticated Projects screen.
- Verified local `/health` returns 200, unauthenticated `/api/projects` returns 401, and a raw HTTP request with an unexpected Host returns 403.
- Generated the local backend token-encryption and GitHub webhook secrets in the ignored `.env`, without printing their values. Keep the token-encryption key identical for all processes sharing this database.

## UI checks

Actual authenticated Projects/setup screenshots are in `.impeccable/review/platform/{desktop,mobile,user-580}.png`. The project overview and test-selection screenshots use an explicitly labeled read-only fixture on a separate loopback server. The fixture never connects to Neon, GitHub, or a coding agent and is not product seed data.

A fresh reviewer identified two test-editor correctness defects. Both were fixed and received regression tests. The reviewer scored editor identity, visible historical selections, and design documentation **resolved**. Its ship verdict covers those scored fixes, not full hosted acceptance. Evidence: `.impeccable/review/platform/review.md` and `verdict.md`.

## Render web deployment

On 2026-09-05, deployed the actual web application to <https://eigen-web-dkcg.onrender.com>.

- Render service: `srv-dae3c62d0e5s73f0b4gg`, Ohio, free instance for initial GitHub App setup.
- Initial deployment: `dep-dae3c6id0e5s73f0b6rg`. Final configuration deployment: `dep-dae3g0m7bikc73fuqe20`, reported `live` by Render.
- Source: `Anushlinux/eigen`, branch `codex/render-pilot-20260905`, commit `86778a8c275db97f411e857c8115654531ae481d`. The snapshot preserves the original local checkout and staging area. Automatic deployment is disabled.
- Configured existing Neon persistence/authentication and backend secrets through Render's environment API. No secret values were published in Git or recorded here.
- Added and verified `https://eigen-web-dkcg.onrender.com` in Neon Auth's trusted domains, preserving the local domain.
- Looked up the existing verified, non-banned Neon account matching the Render account owner and configured its stable user ID as the pilot invitation allowlist.
- Public checks: `/` and `/api/auth/config` returned 200, `/health` returned 200 with `ready`, and unauthenticated `/api/projects` returned 401.
- Sent a locally generated signed `ping` to `/api/github/webhook`: accepted with 200 and `duplicate: false`; replaying the same delivery returned 200 and `duplicate: true`. An invalid signature returned 401. This proves the deployed endpoint and database receipt persistence, not delivery from an installed GitHub App.

The web service uses the existing production Neon database and invitation enforcement. The free instance is only the setup deployment; it can sleep when idle. No always-on background worker has been provisioned. GitHub App registration is still needed before repository integration jobs can run.

The deployed browser sign-in screen rendered, but its Neon Auth request showed `Failed to fetch`. The local system resolver returned `ENOTFOUND` / `EREFUSED` for the Neon database and Auth hostnames. Resolving those same names through Cloudflare DNS over HTTPS allowed a TLS-verified database account lookup and an Auth request; the Auth response explicitly allowed the Render origin and credentials. Render's database connection and health check succeeded. This is a local DNS blocker to the browser sign-in acceptance check; no machine network settings were changed, and hosted interactive sign-in is not claimed as verified.

## Live acceptance not performed

The following require external account configuration and remain unverified:

- Eigen GitHub App registration/installation and real user authorization callback.
- Real repository download, E2B isolation, coding-agent integration, and an actual integration PR.
- Real AI test drafting and sample-repository financial evaluations through the hosted worker.
- A real repair PR with unchanged-test before/after evidence.
- Actual GitHub webhook delivery, GitHub reviews/merges, and automatic runs.
- Render worker deployment, live worker restart recovery, and a second-user hosted access test.

No real integration or repair PR was created in this implementation session. The web service is deployed; the complete hosted workflow has not passed acceptance. No customer production deployment or live financial payment is claimed.

Remaining setup: GitHub App credentials/configuration and the always-on worker/compute plan. E2B and Render keys are present; live E2B execution remains unverified. The inventory and exact callback routes are in `docs/hosted-deployment.md` and `.env.hosted.example`.
