---
name: Eigen
description: A financial flight recorder for evidence-backed payment-agent decisions.
colors:
  bone-field: "#f2eedf"
  evidence-paper: "#faf7eb"
  recorder-ink: "#101317"
  ink-soft: "#30343a"
  ledger-rule: "#a7a18f"
  ledger-rule-dark: "#55564f"
  action-cobalt: "#2456ff"
  action-cobalt-pale: "#dfe6ff"
  fault-vermilion: "#e44a35"
  fault-vermilion-pale: "#f7ddd6"
  verified-green: "#2e8b57"
  verified-green-pale: "#dcebdc"
  focus-violet: "#8a3ffc"
  workspace-status-neutral: "#e5e0d0"
  workspace-status-success-ink: "#14512d"
  workspace-status-error-ink: "#862714"
  workspace-status-working-ink: "#133291"
typography:
  display:
    fontFamily: "Avenir Next Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(2.6rem, 5.2vw, 5.6rem)"
    fontWeight: 900
    lineHeight: 0.88
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Avenir Next Condensed, Arial Narrow, sans-serif"
    fontSize: "1.65rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "0.68rem"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.08em"
  workspace-page:
    fontFamily: "Avenir Next Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(2.4rem, 4vw, 4.5rem)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.025em"
  workspace-section:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "normal"
  workspace-subsection:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.1rem"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "normal"
  workspace-body:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  workspace-control:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.45
    letterSpacing: "normal"
  workspace-label:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.9rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "normal"
  workspace-support:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
  workspace-status:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.82rem"
    fontWeight: 700
    lineHeight: 1.45
    letterSpacing: "normal"
  workspace-metadata:
    fontFamily: "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
rounded:
  square: "0"
spacing:
  hairline: "1px"
  xs: "0.35rem"
  sm: "0.65rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "3.2rem"
components:
  button-primary:
    backgroundColor: "{colors.recorder-ink}"
    textColor: "{colors.evidence-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0.75rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.action-cobalt}"
    textColor: "{colors.evidence-paper}"
  input-field:
    backgroundColor: "{colors.evidence-paper}"
    textColor: "{colors.recorder-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.square}"
    padding: "0.75rem"
  decision-pass:
    backgroundColor: "{colors.verified-green}"
    textColor: "{colors.evidence-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0.48rem 0.65rem 0.38rem"
  decision-block:
    backgroundColor: "{colors.fault-vermilion}"
    textColor: "{colors.evidence-paper}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0.48rem 0.65rem 0.38rem"
  recorder-panel:
    backgroundColor: "{colors.recorder-ink}"
    textColor: "{colors.evidence-paper}"
    rounded: "{rounded.square}"
    padding: "1rem"
  workspace-button-primary:
    backgroundColor: "{colors.recorder-ink}"
    textColor: "{colors.evidence-paper}"
    typography: "{typography.workspace-control}"
    rounded: "{rounded.square}"
    padding: "0.65rem 1rem"
  workspace-button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.recorder-ink}"
    typography: "{typography.workspace-control}"
    rounded: "{rounded.square}"
    padding: "0.65rem 1rem"
  workspace-input:
    backgroundColor: "{colors.evidence-paper}"
    textColor: "{colors.recorder-ink}"
    rounded: "{rounded.square}"
    padding: "0.8rem"
  workspace-status-success:
    backgroundColor: "{colors.verified-green-pale}"
    textColor: "{colors.workspace-status-success-ink}"
    typography: "{typography.workspace-status}"
    rounded: "{rounded.square}"
    padding: "0.32rem 0.65rem"
  workspace-status-error:
    backgroundColor: "{colors.fault-vermilion-pale}"
    textColor: "{colors.workspace-status-error-ink}"
    typography: "{typography.workspace-status}"
    rounded: "{rounded.square}"
    padding: "0.32rem 0.65rem"
  workspace-status-working:
    backgroundColor: "{colors.action-cobalt-pale}"
    textColor: "{colors.workspace-status-working-ink}"
    typography: "{typography.workspace-status}"
    rounded: "{rounded.square}"
    padding: "0.32rem 0.65rem"
---

# Design System: Eigen

## Overview

**Creative North Star: "The Financial Flight Recorder"**

Eigen looks like an evidence instrument, not an analytics product. Warm paper establishes a calm inspection field; near-black recorder strips hold the event sequence; thin rules make relationships exact without adding decorative weight. The interface is dense, but its hierarchy stays legible because type scale, sequence, and status color each have one job.

The visual language is forensic and restrained. Large condensed headlines state the conclusion. Monospaced labels expose identifiers, timestamps, and system state. Cobalt marks deliberate safe action, vermilion marks ambiguity or an unsafe financial effect, and green is reserved for deterministically verified success.

The project workspace extends this incumbent Operate interface with readable forms, ruled project lists, and sentence-case actions. Its scoped variants below apply to repository projects, test editing, and the project run wrapper; existing local-report typography, navigation, recorder lanes, and evidence inspectors retain their established treatment. No new visual world or comp was selected.

**Key Characteristics:**

- Warm evidence-paper surfaces surrounding near-black recorder lanes.
- Square geometry and hairline ledger rules instead of soft cards or floating panels.
- Synchronized event sequences with a visible fault seam and inspectable evidence.
- Condensed display type paired with plain body text and monospaced system labels.
- Explicit offline, Test Mode, PASS, BLOCK, ALLOW, and configuration states.

## Colors

The palette behaves like an instrument panel: a warm neutral field, dark recording surfaces, one action color, one fault color, and one verified-success color.

### Primary

- **Action Cobalt:** Marks selected safe actions, comparison language, focus-adjacent emphasis, and intentional reconciliation behaviour.

### Secondary

- **Fault Vermilion:** Marks the lost-response seam, ambiguous results, duplicate effects, blocked decisions, and destructive confirmation states.

### Tertiary

- **Verified Green:** Appears only when deterministic evidence supports a completed or allowed state. Its pale companion is used for readable proof rows.
- **Focus Violet:** Provides a clearly distinguishable keyboard focus ring without competing with product-state colors.

### Neutral

- **Bone Field:** The page canvas and persistent navigation field.
- **Evidence Paper:** High-contrast content panels, scenario selectors, and inspector surfaces.
- **Recorder Ink:** Recorder lanes, active navigation, structured payload panels, and primary controls.
- **Soft Ink:** Secondary explanatory copy.
- **Ledger Rules:** Hairline dividers at light and dark contrast levels.

### Project workspace status variants

Workspace status labels use dark success, error, and working inks on their corresponding pale fills; neutral states use recorder ink on the workspace neutral fill. These text-and-fill pairs exceed 4.5:1 contrast at their normal text size. The existing saturated local-report decision stamps remain separate variants.

**The Scoped Status Rule.** Always name what a status verifies. “Integration: Ready” confirms integration readiness; it does not claim that financial tests passed. Show the financial result separately, and retain the visible simulated-payments label.

### Named Rules

**The Evidence Color Rule.** Status colors describe evidence, not decoration. Green cannot appear unless the state has been deterministically verified.

**The One Fault Rule.** Vermilion draws the single shared fault boundary first; related unsafe events may echo it, but they cannot create competing focal points.

## Typography

**Display Font:** Avenir Next Condensed (with Arial Narrow and sans-serif fallbacks)  
**Body Font:** Inter (with system sans-serif fallbacks)  
**Label/Mono Font:** SFMono-compatible system monospace

**Character:** The condensed display face makes decisive statements feel stamped and operational. The body face remains quiet and readable, while monospaced text makes event identity, sequence, and configuration state easy to scan.

### Hierarchy

- **Display** (900, fluid 2.6rem–5.6rem, 0.88 line-height): One decisive page statement, set in uppercase.
- **Title** (700, 1.65rem, 1 line-height): Agent names, section titles, and selected evidence headings.
- **Body** (400, 0.95rem, 1.45 line-height): Explanations, limited to roughly 65–68 characters where the layout permits.
- **Label** (800, 0.68rem, 0.08em tracking): Uppercase system state, evidence categories, sequence metadata, and controls.

### Project workspace hierarchy

The workspace uses the same font families with a calmer, sentence-case ramp. Page titles use `workspace-page`; section and subsection headings use `workspace-section` and `workspace-subsection`. Body copy uses `workspace-body` and a maximum measure of 72ch. The inherited root font size is 1rem; only paragraphs raise line-height to 1.55.

Controls use `workspace-control`, with no uppercase transformation or added tracking. Labels use `workspace-label`; run rows and supporting paragraphs also use its 0.9rem size at regular weight. Secondary repository descriptions and environment text use `workspace-support`. Status labels use `workspace-status`; timestamps, footer text, and code details use the compact metadata size. Status words are capitalized by the implementation, while action and tab text remain sentence case.

The empty-state heading is a dedicated fluid treatment (1.8rem–2.8rem, 3vw, 1.15 line-height), constrained to 22ch. At the narrow breakpoint, tabs use 0.87rem and test-row edit controls use 0.8rem. These local adjustments are not new global type steps.

**The Readable Action Rule.** Project actions and navigation use plain body-family text in sentence case. Preserve uppercase monospaced controls only on the existing local-report surfaces that already use them.

### Named Rules

**The Claim First Rule.** The largest type states the product truth or comparison thesis, never a decorative slogan.

**The Identifier Rule.** IDs, currency totals, timestamps, and configuration states use tabular or monospaced text so differences remain visually stable.

## Layout

Desktop uses a broad evidence canvas capped at 108rem. The primary comparison is one connected composition: a scenario selector, two synchronized recorder strips, one shared fault seam, a narrow delta column, and an inline evidence inspector. Spacing uses a compact 0.35rem–1.5rem rhythm inside the recorder and up to 3.2rem at the page edge.

At 760px and below, the recorder strips become one ordered phase stack. Each phase keeps baseline and candidate evidence side by side, preserves the sequence number and lane label, then places exact deltas and the inspector below. Scenario choices remain horizontally scrollable rather than shrinking into illegible text.

**The Connected Proof Rule.** If one decision depends on several events, keep those events in one uninterrupted composition rather than splitting them into unrelated cards.

### Project workspace layout

The project canvas is capped at 1380px with 3.2rem horizontal desktop padding. Ruled sections organize the next action, pull requests, saved tests, and evaluation history. Forms and test templates use two equal columns; editor and draft panels are capped at 850px, while settings and repository search are capped at 650px. Actions wrap with a 0.75rem gap.

At 850px and below, page padding becomes 1.5rem, next-action content stacks, project and run rows reduce to two columns, and setup notices stack. At 520px and below, horizontal page padding becomes 1rem, headings stack above actions, forms/templates/project rows become one column, timestamps precede event details, and footer content stacks. Tabs wrap in reading order rather than clipping; the environment label takes its own header row. Long repository names and evidence text can wrap. Existing embedded trial evidence keeps its local-report layout rules.

## Elevation & Depth

The system is flat. It uses no box shadows or translucent layers. Depth comes from tonal contrast between paper and recorder ink, plus borders that reveal containment and sequence.

**The Flat Evidence Rule.** Surfaces never float above the evidence. A state change is shown through color, rule weight, or selection—not elevation.

## Shapes

Corners are square. Containers use one-pixel borders, recorder milestones use rotated square nodes, and status stamps use rectangular silhouettes. This geometry keeps the interface closer to a ledger, instrument panel, and printed proof sheet than a consumer application.

**The No Soft Card Rule.** Do not introduce rounded dashboard cards, pill-shaped status chips, or decorative blobs.

## Components

### Buttons

- **Shape:** Square with a one-pixel border.
- **Primary:** Recorder ink with evidence-paper text and compact uppercase label typography.
- **Hover / Focus:** Hover may shift to cobalt or a tonal paper state. Keyboard focus always receives the violet three-pixel outline with a three-pixel offset.
- **Danger:** Vermilion is reserved for the confirmed Test Mode write step and other explicitly risky actions.

### Inputs / Fields

- **Style:** Evidence-paper background, one-pixel ledger stroke, square corners, and an explicit text label above the field.
- **Focus:** Violet outline with three-pixel offset; focus never relies on a subtle border-color change.
- **Error / Disabled:** Error copy and borders use fault vermilion. Disabled actions use a neutral paper tone and remain visibly inactive.

### Navigation

Navigation is a ruled top rail. Tabs use uppercase monospaced labels; the active tab reverses to recorder ink with evidence-paper text. On mobile, product identity and tabs stay on the first row while environment truth moves to a separate, horizontally safe row.

### Project workspace controls and navigation

- **Actions:** Square, at least 44px high, with sentence-case body-family text. Primary actions use recorder ink and shift to cobalt on hover; secondary actions have a dark ledger border and pale-cobalt hover fill. Disabled buttons reduce opacity to 0.55 and use the unavailable cursor.
- **Fields:** Square evidence-paper inputs, selects, and textareas with explicit labels, 0.8rem padding, and a 44px minimum height. Checkboxes and radios retain their native shape with cobalt accent. Editor forms use the two-column layout above and stack on narrow screens.
- **Tabs:** Text links on a ledger rule. Selection uses a three-pixel cobalt underline and darker cobalt text, with `aria-current="page"`. Tabs retain their text labels and visible focus ring; the project variant does not use the reversed local-report tab treatment.
- **Focus:** All workspace interactive elements receive the existing three-pixel violet outline and three-pixel offset.
- **Statuses and errors:** Rectangular text labels use the pale status variants above. Error notices add a border and expose alert semantics; loading messages expose status semantics. Color always accompanies readable state text.
- **Run evidence:** The wrapper names the financial outcome, exact commit, model, and simulated-payment context. The test selector carries a Passed or Failed label. Before-and-after tables show both results and state whether settings are comparable. The embedded trial inspector retains the established report components.

### Recorder Strip

The recorder is the signature component. A near-black lane carries numbered milestones on a hairline track. The same scenario is aligned across baseline and candidate, and the shared fault seam cuts through both lanes. Selecting a milestone changes the structured inspector below without changing sequence.

### Evidence Delta

The delta column uses exact before-and-after values for refund count, duplicate effects, safe completion, decision, and critical findings. It must show both sides of the comparison; green alone is never enough.

### Proof Checklist

The smoke checklist renders six fixed proof obligations. Each row includes a symbol and text label so PASS or BLOCK is not communicated by color alone.

## Do's and Don'ts

### Do:

- **Do** show whether evidence is simulated, offline-verified, or observed from a credentialed Test Mode run.
- **Do** keep money in integer minor units and use tabular formatting for exact totals.
- **Do** preserve event order, correlation identifiers, provider exchange summaries, and linked findings.
- **Do** reserve green for verified success and vermilion for ambiguity, unsafe effects, or blocked decisions.
- **Do** use a structured mobile stack when aligned desktop lanes no longer fit.
- **Do** keep project actions sentence case, selected tabs underlined, and integration readiness separate from financial test results.

### Don't:

- **Don't** imply that offline tests are a live Razorpay proof.
- **Don't** use gradients, glass effects, decorative charts, floating shadows, or generic analytics cards.
- **Don't** hide a retry, duplicate effect, pending refund, or mismatched claim behind an aggregate score.
- **Don't** rely on color alone; pair every state with a label, number, symbol, or sequence position.
- **Don't** add imagery that competes with the real product content: traces, reports, findings, and provider truth.
