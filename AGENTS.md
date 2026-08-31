# Eigen Engineering Rules

- Represent money only as integer currency subunits.
- Judge financial correctness with deterministic code, never an LLM.
- Inject clocks and ID generators. Core tests must be reproducible.
- Put every payment provider and agent provider behind an interface.
- Never accept live Razorpay credentials.
- Every feature requires tests.
- Finish every task by running `pnpm check`.
