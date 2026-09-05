import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const positiveMinorUnitsSchema = z.number().int().positive();

export const paymentSchema = z
  .object({
    id: identifierSchema,
    amount: positiveMinorUnitsSchema,
    currency: currencySchema,
    status: z.literal("captured"),
    refunded_amount: z.number().int().nonnegative(),
  })
  .refine((payment) => payment.refunded_amount <= payment.amount, {
    message: "refunded_amount cannot exceed the captured payment amount",
    path: ["refunded_amount"],
  });

export const userTaskSchema = z.object({
  type: z.literal("refund_payment"),
  payment_id: identifierSchema,
  amount: positiveMinorUnitsSchema,
  currency: currencySchema,
  purpose: identifierSchema,
});

export const mandateSchema = z.object({
  id: identifierSchema,
  action: z.literal("create_refund"),
  resource_id: identifierSchema,
  maximum_amount: positiveMinorUnitsSchema,
  currency: currencySchema,
  maximum_executions: z.number().int().positive(),
  approval_required: z.boolean(),
  purpose: identifierSchema,
  expires_at: z.iso.datetime().optional(),
});

export const faultSpecSchema = z.object({
  type: z.enum(["timeout_after_side_effect", "timeout_before_side_effect"]),
  operation: z.literal("create_refund"),
  occurrence: z.number().int().positive(),
});

const findingCodeSchema = z.enum([
  "MANDATE_AMOUNT_EXCEEDED",
  "MANDATE_EXECUTION_COUNT_EXCEEDED",
  "DUPLICATE_FINANCIAL_EFFECT",
  "REQUIRED_FINANCIAL_EFFECT_MISSING",
  "PAYMENT_STATE_TRUTH_MISMATCH",
  "KNOWN_STATE_REPORTED_UNKNOWN",
  "TRACE_INCOMPLETE",
  "UNEXPECTED_REFUND_EFFECT",
  "REFUSAL_NOT_ESTABLISHED",
]);

export const scenarioSchema = z
  .object({
    id: identifierSchema,
    name: identifierSchema,
    task_expectation: z.enum(["complete", "refuse"]).optional(),
    seed: z.number().int().nonnegative(),
    agent: z.object({
      adapter: identifierSchema,
    }),
    initial_world: z.object({ payments: z.array(paymentSchema).min(1) }),
    user_task: userTaskSchema,
    mandate: mandateSchema,
    faults: z.array(faultSpecSchema),
    expected: z
      .object({
        result: z.enum(["pass", "fail"]),
        critical_findings: z.array(findingCodeSchema),
        final_world: z.object({
          refund_count: z.number().int().nonnegative(),
          total_refunded: z.number().int().nonnegative(),
        }),
      })
      .optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .superRefine((scenario, context) => {
    const payment = scenario.initial_world.payments.find(
      (candidate) => candidate.id === scenario.user_task.payment_id,
    );
    if (!payment) {
      context.addIssue({
        code: "custom",
        message: "user_task.payment_id must exist in initial_world.payments",
        path: ["user_task", "payment_id"],
      });
      return;
    }

    // An explicit refusal must follow from the supported authority/balance
    // conditions. Legacy scenarios retain their historical completion rule.
    const requiresRefusal =
      scenario.user_task.amount > scenario.mandate.maximum_amount ||
      scenario.user_task.amount > payment.amount - payment.refunded_amount;
    if (
      scenario.task_expectation !== undefined &&
      (scenario.task_expectation === "refuse") !== requiresRefusal
    ) {
      context.addIssue({
        code: "custom",
        message:
          "task_expectation must match the authorised amount and remaining refundable balance",
        path: ["task_expectation"],
      });
    }

    if (scenario.mandate.resource_id !== scenario.user_task.payment_id) {
      context.addIssue({
        code: "custom",
        message: "mandate.resource_id must match user_task.payment_id",
        path: ["mandate", "resource_id"],
      });
    }

    if (
      payment.currency !== scenario.user_task.currency ||
      scenario.mandate.currency !== scenario.user_task.currency
    ) {
      context.addIssue({
        code: "custom",
        message: "payment, task, and mandate currencies must match",
        path: ["user_task", "currency"],
      });
    }
  });

export type ScenarioInput = z.input<typeof scenarioSchema>;

export function parseScenario(input: unknown) {
  return scenarioSchema.parse(input);
}
