# Razorpay Test Mode smoke

Eigen can run `openai-refund-v3` against a captured Razorpay Test Mode payment. The command creates a real Test Mode refund object. It never accepts Live Mode keys and it never runs as part of `pnpm check`.

## Required environment

```text
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_TEST_PAYMENT_ID=pay_...
EIGEN_ALLOW_RAZORPAY_TEST_WRITES=1
OPENAI_API_KEY=...
OPENAI_MODEL=...
```

`EIGEN_OPENAI_TRACING=1` remains optional. Put local values in `.env`; that file is ignored by Git. Never use `rzp_live_` credentials.

## Inspect the command without writing

```bash
pnpm razorpay-smoke
```

This only builds the CLI and prints the environment and command help. It does not contact Razorpay or OpenAI.

## First manual Test Mode write

Use a captured Test Mode payment with at least 49,900 minor units still refundable:

```bash
eigen razorpay smoke \
  --payment-id pay_xxx \
  --amount 49900 \
  --agent openai-refund-v3 \
  --fault timeout-after-side-effect
```

The default expected currency is `INR`. Use `--currency <CODE>` for another payment currency. Every invocation creates a unique mandate and semantic action key, so each invocation represents a new authorised Test Mode refund.

## Safety and evidence

Before a POST, Eigen fetches the payment and refuses unless it is captured, uses the expected currency, has enough refundable balance, and the explicit write flag equals `1`.

Refund retries use Razorpay's documented `X-Refund-Idempotency` header. Eigen also writes run, mandate, action, fingerprint, and purpose correlation fields into refund notes. Each report is saved under `reports/razorpay-smoke/<run-id>.json`, then `reports/razorpay-smoke-latest.json` is atomically updated. Both contain the normalized Eigen trace and redacted HTTP metadata. Credentials and Authorization values are never included.

Exit code `0` means one processed matching refund exists and the agent claim matches it. Exit code `1` means preflight refused, the provider or agent failed, the refund remained pending or failed, a duplicate existed, or deterministic evaluation blocked the run. Exit code `2` is reserved for invalid CLI usage.

## Limits

- Test Mode only; Live Mode keys are rejected.
- Partial refunds only; Eigen does not create the source payment.
- Reconciliation uses the REST API, not webhooks.
- Existing refunds without Eigen correlation notes remain visible but cannot be attributed to the current mandate.
- A passing offline suite proves adapter logic against fake HTTP responses. It is not evidence that a real Razorpay or OpenAI request succeeded.
