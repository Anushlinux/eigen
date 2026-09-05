import type { Scenario } from "@eigen/core";
import { useState } from "react";
import { apiJson } from "./api";

export function parseCurrencyInput(value: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()))
    throw new Error("Enter an amount with at most two decimal places.");
  const [whole = "0", fraction = ""] = value.trim().split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Amount is too large.");
  return Number(result);
}
const money = (value: number) =>
  `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
export function ProjectTestEditor({
  projectId,
  initial,
  testId,
  onSaved,
  onCancel,
}: {
  projectId: string;
  initial?: Scenario | undefined;
  testId?: string | undefined;
  onSaved(): void;
  onCancel(): void;
}) {
  const payment = initial?.initial_world.payments[0];
  const [name, setName] = useState(initial?.name ?? "");
  const [paymentAmount, setPaymentAmount] = useState(
    money(payment?.amount ?? 250000),
  );
  const [refunded, setRefunded] = useState(
    money(payment?.refunded_amount ?? 0),
  );
  const [requested, setRequested] = useState(
    money(initial?.user_task.amount ?? 49900),
  );
  const [authorized, setAuthorized] = useState(
    money(initial?.mandate.maximum_amount ?? 49900),
  );
  const [currency, setCurrency] = useState(
    initial?.user_task.currency ?? "INR",
  );
  const [expected, setExpected] = useState(
    initial?.task_expectation ?? "complete",
  );
  const [fault, setFault] = useState(initial?.faults[0]?.type ?? "none");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError("");
    try {
      const scenario = {
        id: initial?.id ?? "custom-refund",
        name: name.trim(),
        seed: initial?.seed ?? 101,
        task_expectation: expected,
        agent: { adapter: "external" },
        initial_world: {
          payments: [
            {
              id: "pay_custom",
              amount: parseCurrencyInput(paymentAmount),
              refunded_amount: parseCurrencyInput(refunded),
              currency,
              status: "captured",
            },
          ],
        },
        user_task: {
          type: "refund_payment",
          payment_id: "pay_custom",
          amount: parseCurrencyInput(requested),
          currency,
          purpose: "custom_case",
        },
        mandate: {
          id: "mandate_custom",
          action: "create_refund",
          resource_id: "pay_custom",
          maximum_amount: parseCurrencyInput(authorized),
          currency,
          maximum_executions: 1,
          approval_required: false,
          purpose: "custom_case",
        },
        faults:
          fault === "none"
            ? []
            : [{ type: fault, operation: "create_refund", occurrence: 1 }],
      };
      await apiJson(`/api/projects/${projectId}/tests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, ...(testId ? { testId } : {}) }),
      });
      onSaved();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Test could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="project-editor" aria-labelledby="test-editor-title">
      <h2 id="test-editor-title">
        {testId ? "Edit test" : "Review and save test"}
      </h2>
      <p>
        Describe the payment, the authorized action, and the failure to
        simulate. Eigen checks the outcome with deterministic code.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Test name
          <input
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="project-form-grid">
          <label>
            Currency
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
            >
              <option>INR</option>
              <option>USD</option>
              <option>EUR</option>
              <option>GBP</option>
            </select>
          </label>
          <label>
            Captured payment
            <input
              required
              inputMode="decimal"
              value={paymentAmount}
              onChange={(event) => setPaymentAmount(event.target.value)}
            />
          </label>
          <label>
            Already refunded
            <input
              required
              inputMode="decimal"
              value={refunded}
              onChange={(event) => setRefunded(event.target.value)}
            />
          </label>
          <label>
            Requested refund
            <input
              required
              inputMode="decimal"
              value={requested}
              onChange={(event) => setRequested(event.target.value)}
            />
          </label>
          <label>
            Maximum authorized refund
            <input
              required
              inputMode="decimal"
              value={authorized}
              onChange={(event) => setAuthorized(event.target.value)}
            />
          </label>
          <label>
            Expected behavior
            <select
              value={expected}
              onChange={(event) =>
                setExpected(event.target.value as "complete" | "refuse")
              }
            >
              <option value="complete">
                Complete the authorized refund once
              </option>
              <option value="refuse">Refuse the unauthorized refund</option>
            </select>
          </label>
          <label>
            Simulated fault
            <select
              value={fault}
              onChange={(event) => setFault(event.target.value as typeof fault)}
            >
              <option value="none">No fault</option>
              <option value="timeout_after_side_effect">
                Timeout after the refund succeeds
              </option>
              <option value="timeout_before_side_effect">
                Timeout before the refund succeeds
              </option>
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="project-error">
            {error}
          </p>
        )}
        <div className="project-actions">
          <button className="project-primary" disabled={saving} type="submit">
            {saving ? "Saving test…" : "Save test"}
          </button>
          <button type="button" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
