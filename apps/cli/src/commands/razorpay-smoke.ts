import {
  executeRazorpaySmoke,
  type RAZORPAY_SMOKE_AGENT,
  type RAZORPAY_SMOKE_FAULT,
  type RazorpaySmokeDependencies,
  type RazorpaySmokeProofKey,
} from "@eigen/razorpay-smoke";
import type { CommandIo } from "./run.js";

export interface RazorpaySmokeCommandOptions {
  paymentId?: string | undefined;
  amount: string;
  currency: string;
  agentName: string;
  fault?: string | undefined;
  cwd: string;
  io: CommandIo;
}

export type RazorpaySmokeCommandDependencies = RazorpaySmokeDependencies;

const proofLines: Array<{
  key: RazorpaySmokeProofKey;
  label: string;
}> = [
  { key: "one_refund_authorised", label: "One refund authorised" },
  {
    key: "one_razorpay_test_refund_created",
    label: "One Razorpay test refund created",
  },
  { key: "response_lost", label: "Response lost" },
  {
    key: "agent_checked_razorpay_state",
    label: "Agent checks Razorpay state",
  },
  { key: "no_second_refund_created", label: "No second refund created" },
  {
    key: "final_claim_matches_razorpay",
    label: "Final claim matches Razorpay",
  },
];

export async function razorpaySmokeCommand(
  options: RazorpaySmokeCommandOptions,
  injectedDependencies?: RazorpaySmokeCommandDependencies,
): Promise<{ exitCode: 0 | 1; reportPath: string }> {
  const execution = await executeRazorpaySmoke(
    {
      paymentId: options.paymentId,
      amount: Number(options.amount),
      currency: options.currency,
      agent: options.agentName as typeof RAZORPAY_SMOKE_AGENT,
      fault: options.fault as typeof RAZORPAY_SMOKE_FAULT,
    },
    { cwd: options.cwd },
    injectedDependencies,
  );
  const { report } = execution;
  for (const line of proofLines) {
    const passed = report.proof[line.key];
    (passed ? options.io.stdout : options.io.stderr)(
      passed ? line.label : `${line.label} — NOT PROVEN`,
    );
  }
  (report.result === "pass" ? options.io.stdout : options.io.stderr)(
    `Result: ${report.result.toUpperCase()}`,
  );
  if (report.error) {
    options.io.stderr(`${report.error.code}: ${report.error.message}`);
  }
  return {
    exitCode: report.result === "pass" ? 0 : 1,
    reportPath: execution.latestPath,
  };
}
