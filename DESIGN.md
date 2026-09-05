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
---

# Design System: Eigen

## Overview

**Creative North Star: "The Financial Flight Recorder"**

Eigen looks like an evidence instrument, not an analytics product. Warm paper establishes a calm inspection field; near-black recorder strips hold the event sequence; thin rules make relationships exact without adding decorative weight. The interface is dense, but its hierarchy stays legible because type scale, sequence, and status color each have one job.

The visual language is forensic and restrained. Large condensed headlines state the conclusion. Monospaced labels expose identifiers, timestamps, and system state. Cobalt marks deliberate safe action, vermilion marks ambiguity or an unsafe financial effect, and green is reserved for deterministically verified success.

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

### Named Rules

**The Claim First Rule.** The largest type states the product truth or comparison thesis, never a decorative slogan.

**The Identifier Rule.** IDs, currency totals, timestamps, and configuration states use tabular or monospaced text so differences remain visually stable.

## Layout

Desktop uses a broad evidence canvas capped at 108rem. The primary comparison is one connected composition: a scenario selector, two synchronized recorder strips, one shared fault seam, a narrow delta column, and an inline evidence inspector. Spacing uses a compact 0.35rem–1.5rem rhythm inside the recorder and up to 3.2rem at the page edge.

At 760px and below, the recorder strips become one ordered phase stack. Each phase keeps baseline and candidate evidence side by side, preserves the sequence number and lane label, then places exact deltas and the inspector below. Scenario choices remain horizontally scrollable rather than shrinking into illegible text.

**The Connected Proof Rule.** If one decision depends on several events, keep those events in one uninterrupted composition rather than splitting them into unrelated cards.

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

### Don't:

- **Don't** imply that offline tests are a live Razorpay proof.
- **Don't** use gradients, glass effects, decorative charts, floating shadows, or generic analytics cards.
- **Don't** hide a retry, duplicate effect, pending refund, or mismatched claim behind an aggregate score.
- **Don't** rely on color alone; pair every state with a label, number, symbol, or sequence position.
- **Don't** add imagery that competes with the real product content: traces, reports, findings, and provider truth.
