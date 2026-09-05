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

## Live acceptance not performed

The following require external account configuration and remain unverified:

- Eigen GitHub App registration/installation and real user authorization callback.
- Real repository download, E2B isolation, coding-agent integration, and an actual integration PR.
- Real AI test drafting and sample-repository financial evaluations through the hosted worker.
- A real repair PR with unchanged-test before/after evidence.
- Deployed signed webhooks, GitHub reviews/merges, and automatic runs.
- Render web/worker deployment, live worker restart recovery, and a second-user hosted access test.

No real integration or repair PR was created in this implementation session. No hosted release, customer production deployment, or live financial payment is claimed.

Remaining setup: GitHub App credentials/configuration, `E2B_API_KEY`, Render account access, final HTTPS origin, and the invited Neon user IDs. The inventory and exact callback routes are in `docs/hosted-deployment.md` and `.env.hosted.example`.
