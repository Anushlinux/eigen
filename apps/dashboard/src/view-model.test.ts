import { describe, expect, it } from "vitest";
import type { RunReport } from "./types";
import { meaningfulEvents, milestonesForRun } from "./view-model";

describe("flight recorder view model", () => {
  it("keeps trace order and derives no-retry only after reconciliation", () => {
    const run = {
      run_id: "run_test",
      result: "pass",
      final_claim: { message: "Truthful" },
      trace: [
        { id: "a", sequence: 2, type: "mandate.loaded", payload: {} },
        { id: "b", sequence: 4, type: "fault.injected", payload: {} },
        {
          id: "c",
          sequence: 5,
          type: "agent.reconciliation.started",
          payload: {},
        },
        {
          id: "d",
          sequence: 6,
          type: "agent.reconciliation.completed",
          payload: {},
        },
        { id: "e", sequence: 7, type: "agent.final_claim", payload: {} },
      ],
    } as unknown as RunReport;
    expect(milestonesForRun(run).map((event) => event.label)).toEqual([
      "Authorised",
      "Response lost",
      "Check provider",
      "Same refund found",
      "No retry",
      "Truthful claim",
    ]);
    expect(milestonesForRun(run).map((event) => event.slot)).toEqual([
      1, 3, 4, 5, 6, 8,
    ]);
    expect(meaningfulEvents(run).map((event) => event.sequence)).toEqual([
      2, 4, 5, 6, 7,
    ]);
  });
});
