# Eigen Dashboard Surface Brief

## Mode

Operate. This is a dense developer tool for inspecting payment-agent evidence and launching one guarded Razorpay Test Mode proof.

## Audience and Primary Job

The primary user is a payment-agent developer. They need to see exactly where two agents diverge, inspect the underlying evidence, and confirm whether one authorised refund remained one provider-side effect after a lost response.

## Approved Direction

The visual north star is `.impeccable/mocks/dashboard-flight-recorder-c.png`. Recreate its paired recorder composition with real semantic HTML and CSS; do not ship the comp as interface content.

The visual world is a financial flight recorder: warm bone field (`#F2EEDF`), near-black ink (`#101317`), cobalt (`#2456FF`) for safe action, vermilion (`#E44A35`) for faults and duplicate effects, and green (`#2E8B57`) only for verified success. Use thin rules, squared panels, tabular numerals, and restrained condensed typography. Avoid generic analytics cards, decorative charts, gradients, glass, and excessive rounding.

## Information Architecture

- Compare is the default view: baseline and candidate recorder strips sit side by side with a shared vertical fault seam and a narrow evidence-delta column.
- One scenario row selects the evidence shown in both strips.
- Selecting an event reveals its structured payload, correlation identifier, HTTP exchange summary, and linked deterministic findings.
- Runs contains immutable Razorpay smoke history plus the preflight and typed-confirmation flow.
- A smoke report uses four synchronized truth lanes: mandate, agent, Razorpay, and user-facing claim.
- The first viewport must expose PASS or BLOCK and the connected proof path without requiring a scroll.

## Responsive Behaviour

Desktop keeps the paired comparison and aligned fault seam. Narrow screens stack both traces into one ordered evidence flow, preserve every lane label and sequence number, then place deltas and the evidence inspector below it. Controls remain keyboard reachable and focus-visible.

## Direction Contract

Seed key: `d116688c`.

The application root must include this contract as its first rendered child:

```html
<!--
THESIS: Eigen is a financial flight recorder, showing where agent intent diverges from provider truth.
OWN-WORLD: Warm evidence paper, ink recorder strips, cobalt verified action, vermilion ambiguity, and hairline ledger rules.
STORY: Compare the same authorised refund across two agents, cross the shared lost-response seam, inspect the exact evidence, then run a guarded Test Mode proof.
FIRST VIEWPORT: Decision, paired traces, shared fault seam, and evidence deltas are visible together.
FORM: Dense paired recorder composition with square geometry, synchronized sequence, and an inline evidence inspector.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->
```

## Boundaries

Do not imply a live Razorpay run has happened when only offline tests exist. Do not add payment creation, webhooks, production monitoring, authentication, a scenario editor, new agent types, or a larger scenario pack.
