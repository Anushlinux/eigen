# Milestone 2: saved external evaluation findings

Status: implemented and accepted on 5 September 2026. This date records milestone review, not the date of a saved evaluation.

## Goal and scope

A developer can open a completed external evaluation, select a scenario and trial, understand its recorded financial outcome, and inspect the original events behind a finding. The surface extends the existing dashboard shell, status stamps, selectors, and evidence inspector. It preserves the visual identity in `DESIGN.md`; this milestone does not establish a new design system.

The existing external application, including its deliberately unsafe retry, remains the system under test. Viewing a saved report makes no application, OpenAI, or payment-provider calls and does not rewrite evidence or re-evaluate the verdict.

## Completed implementation stages

1. **Read and validate saved evidence.** `GET /api/reports` lists external history. `GET /api/reports/external/<suite-id>` (or `latest`) returns a validated saved suite. Reads are confined to the resolved `reports/` directory. Runs come from embedded reports; recorded `report_path` values are never followed. Missing, malformed, incomplete, and unsupported evidence has an explicit unavailable state.
2. **Select and explain a trial.** Selection uses suite ID, scenario ID, and `run_number`, because deterministic run IDs can repeat. The view shows the recorded verdict and deployment decision, mandate, new committed refunds, amount beyond authorisation, original claim, and evaluator findings. Money calculations use integer minor units, exclude pre-existing refunds, and keep currencies separate.
3. **Inspect supported causes.** A complete duplicate-refund sequence requires matching financial identity, correlation IDs, and event order across request, creation, lost response, application retry, and second creation. Finding links and supporting events open the existing inspector with exact original payloads. Missing support produces an explicit explanation and individual recorded facts. The full trace remains available.
4. **Verify the finished surface.** Offline checks, actual browser interaction, viewport inspection, and an independent visual review are complete.

## Acceptance evidence

- The final `CI=true pnpm check` passed with 171 tests across 24 files, plus build, type checking, and Biome checks. Elevated execution allowed localhost test servers. This includes the final directory-confinement and filename-disclosure regressions. Offline fixtures cover report loading and validation, selection identity, financial amounts, causal links, and existing comparison/smoke support; they make no provider requests.
- The implementation session inspected saved suite `external_e01e1a99-f0ef-4228-97c6-c29f177270b4` in the running dashboard. Normal and failed trials displayed correctly. The failed trial showed INR 499.00 authorised once, two INR 499.00 refunds, and INR 499.00 beyond authorisation. These correspond to integer amounts 49900, 99800 total, and 49900 excess.
- Browser inspection confirmed exact retry, request, and refund payloads; the original claim; full-trace access; Compare and Runs navigation; and no browser console errors. The second refund event `event_2u_019` linked all three findings, and the full trace expanded to show 31 events. Keyboard Tab exposed visible focus, and Enter activated a supporting event.
- Desktop at 1280 × 720 and narrow view at 390 × 844 had no horizontal overflow. Six reliable viewport captures are retained under `.impeccable/review/milestone-2/`: `desktop.png`, `desktop-finding.png`, `desktop-inspector.png`, `mobile.png`, `mobile-finance.png`, and `mobile-cause.png`. A corrupt full-page stitched capture was discarded.
- Independent screenshot and source review found no material visual blocker and recommended shipping. That review is separate from the implementation session's keyboard verification; it is not independent keyboard proof.

## Evidence boundaries and remaining limits

Only external suite schema 1.0 with embedded run schema 1.1 is supported. Saved suites do not record a wall-clock evaluation date; simulator timestamps use an injected logical clock. A processed simulated refund is not bank settlement.

The UI distinguishes saved live OpenAI inference from model test doubles, execution errors from financial findings, and application claims from Eigen-generated fallback claims. Missing causal support remains visible. The existing environment configuration was reused without exposing its values. Acceptance added no new provider runs, AI diagnosis, generated repair, scenarios, or infrastructure. Work stops at this milestone.

See `direction.md` for the active contract and `docs/external-agent.md` for execution and usage details.
