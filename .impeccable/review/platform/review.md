disposition: fix

Inputs: no new direction-roll seed, QUALITY BAR card, or approved comp applies to this incumbent extension; the parent confirmed DESIGN.md and the existing application as authority. Review uses the seven supplied captures, supplied source files, PRODUCT.md, DESIGN.md, detector findings, and craft floor; backend acceptance and unsupplied UI states are unverified.

## persistence

Pass: PRODUCT.md and the incumbent DESIGN.md exist. All seven required captures exist and are valid: desktop.png, mobile.png, user-580.png, overview-desktop.png, overview-mobile.png, tests-desktop.png, and tests-mobile.png. The project overview and tests captures visibly identify themselves as UI fixtures, not live agent or PR evidence. No new comp approval or hero reproduction is required for this extension. DESIGN.md describes the retained palette, square geometry, and display character, but needs to document the intentional project-workspace variants listed below.

## fidelity

| Element / promise | Classification | Evidence |
| --- | --- | --- |
| TYPE | adaptation | Condensed repository/page headings retain the incumbent character. Body-sized, sentence-case actions and navigation improve the operational workflow requested by the user; this extends the existing app rather than selecting a new visual world. Document these variants. |
| MATERIAL | match | Flat paper fields, hairline dividers, square controls, and no invented physical texture. |
| GROUND | match | The supplied renders retain the warm bone field and lighter paper panel; projects.css uses DESIGN.md's #f2eedf and #faf7eb values. |
| Project navigation and reading order | adaptation | Overview, Tests, Runs, Agent activity, Settings are present; the narrow captures wrap Settings onto a second line without clipping. This is a readable responsive adaptation to the user's requested five destinations. |
| Repository setup and retained access | match | Actual authenticated captures show setup requirements, repository entry actions, sign-out, simulated-payment labeling, and local-report access. |
| Integration versus financial results | match | Overview explicitly separates a working integration from passing financial tests; PR copy separates integration verification from evaluation evidence. |
| Recorded progress and claims | match | Source displays saved jobs/events; synthetic overview/test evidence is visibly labeled. Live GitHub/E2B/Render behavior is not established by this review. |
| Visible test selection reflects the run | contradicted | ProjectsApp.tsx:937 initializes selection from suite version IDs, but :940 hides every superseded version. A suite pinned to v1 can still run v1 while only unchecked v2 is visible. |
| Editing a chosen test preserves its identity | contradicted | ProjectsApp.tsx:1098 reuses an unkeyed editor while row controls at :1140 can replace its initial/testId props. ProjectTestEditor.tsx:30 initializes form state only on mount; saving can apply the previous test's values to the newly selected test ID. |

## ceiling

The incumbent operational language is sufficient for these setup and test-list surfaces. No additional ornament, motion, or imagery is warranted. Detector findings are advisory type-ramp and palette-documentation drift; no second detector was run. Keyboard focus, labels, native input semantics, and mobile controls are present in source, but interactive keyboard behavior was not exercised in this file-and-image review.

## material_fixes

1. Test identity / product truth: make changing the chosen editor target either remount/reset the complete form with an explicit identity or require finishing/cancelling the current edit first; prevent silent reassignment of existing draft values, and add a test that opens A then B and saves B.
2. Test selection / product truth: render every selected saved version, including older versions pinned by the suite, with its version and a visible deselect control; keep the run count equal to visible selections and do not silently upgrade saved versions; test a suite pinned to v1 after v2 is created.
3. Persistence: document the project-workspace typography, sentence-case controls, underline-selected tabs, and accessible status text colors in DESIGN.md so its operational variants agree with the built extension; retain the incumbent styles used by local reports.

## keep

Keep warm bone and ink, square controls, restrained cobalt selection, readable mobile reflow, visible fixture labels, Neon identity, local reports, and the explicit separation between integration readiness and financial correctness.
