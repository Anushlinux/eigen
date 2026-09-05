# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React and Vite for the dashboard client, Node.js for authenticated project APIs and a separate Render worker, Neon for authentication and durable project records, and E2B for isolated repository execution. The local CLI and report server remain supported.

## Users

Eigen is for developers building merchant-side payment agents, beginning with refund agents that use Razorpay. They use it before deployment to understand whether an agent carried out one authorised financial action exactly once and described the result truthfully.

## Product Purpose

Eigen is a developer-facing payment-agent testing and evaluation system. It runs controlled scenarios, injects realistic faults, records the full execution trace, compares agent behaviour with authoritative payment state, and returns an evidence-backed pass or block decision.

## Positioning

Razorpay proves that payment APIs work. Eigen proves that the complete agent-plus-payment system preserves human authority, avoids duplicate financial effects, reconciles ambiguous outcomes, and communicates the authoritative result.

## Operating Context

Invited developers use repository-backed projects through the hosted dashboard. GitHub App access is separate from Neon sign-in. Integration and repair changes arrive as reviewable PRs; evaluations identify their exact source commit. Developers can also use Eigen locally through its CLI and dashboard. The deterministic `PaymentWorld` remains the reproducible test environment. Selected manual smoke runs can use a captured Razorpay Test Mode payment and the `openai-refund-v3` agent. JSON reports under `reports/` are immutable evidence inputs for the dashboard.

## Capabilities and Constraints

- Money is represented only as integer currency subunits.
- Deterministic code, never a language model, decides financial correctness.
- The system supports payment lookup, partial refund creation, refund reconciliation, timeout fault injection, agent comparison, regression replay, and trace inspection.
- Razorpay integration is Test Mode only. Live credentials are rejected.
- The dashboard may initiate a guarded Test Mode smoke run, but credentials remain server-side and every write requires preflight plus typed confirmation.
- Automated tests never make Razorpay or OpenAI network requests.
- Eigen is not a production payment processor, customer production deployment service, or generic agent observability dashboard.

## Brand Commitments

The product name is Eigen. Its voice is direct, technical, calm, and evidence-first. It must clearly separate verified facts, simulated evidence, Test Mode objects, and unverified live behaviour. No existing logo, palette, font system, or marketing imagery is authoritative.

## Evidence on Hand

- `direction.md` is the product and engineering contract.
- Scenario YAML, run reports, comparison reports, regression reports, and traces are the real product content.
- The deterministic unsafe refund demo, safe-agent comparison, OpenAI experiment path, regression replay, and offline-tested Razorpay adapter already exist.
- No credentialed Razorpay Test Mode smoke result is currently available, so the interface must not imply live verification.

## Product Principles

- One authorised intent may produce no more than one permitted financial effect.
- The trace is evidence, not decoration.
- Payment truth and deployment decisions remain deterministic.
- Ambiguous outcomes are reconciled before retrying.
- Every claim must state whether it comes from simulation, offline testing, or an observed provider run.

## Accessibility & Inclusion

The dashboard must remain usable with a keyboard, preserve a clear reading order on narrow screens, avoid relying on color alone, expose structured alternatives to visual timelines, and respect reduced-motion preferences.
