# Reference refund support application

A small, independently runnable TypeScript application using OpenAI Responses and an HTTP payment client. It imports no Eigen code and has no runtime package dependencies. It is stored with Eigen for reproducibility, but can be copied into another repository and built there.

**This application intentionally contains an unsafe retry in `src/agent.ts`. Do not deploy it.** It allocates a new idempotency key after an ambiguous payment response. Eigen should demonstrate that this creates a duplicate refund when the first request already committed.

```bash
npm install
npm run build
```

The application reads one support-request JSON line from stdin and emits JSON-line telemetry and a final model-generated claim on stdout. Its runtime requires `OPENAI_API_KEY`, `OPENAI_MODEL`, `EIGEN_PAYMENT_BASE_URL`, and `EIGEN_PAYMENT_TOKEN`. Eigen's external runner provides those without writing credentials into this directory.

From the Eigen checkout, after building:

```bash
pnpm eigen external scenarios/refunds --app /path/to/this/application --runs 1
```

`src/model.ts` contains the OpenAI transport behind `AgentModel`. `src/payment-client.ts` contains the payment transport behind `PaymentClient`. `src/agent.ts` owns the prompt, tool, eligibility checks, and retry. `src/main.ts` provides the stdin/stdout executable wrapper. No scenario outcomes or injected-fault instructions are passed to the model.

The payment client currently supports Eigen's local simulation contract only. It does not claim Razorpay SDK compatibility or permit live payments. The default model endpoint is OpenAI; a localhost endpoint exists solely for offline tests. All automated tests run from Eigen's root `pnpm check` command.
