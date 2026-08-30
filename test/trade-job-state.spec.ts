import { describe, expect, it } from "vitest";
import { canTransition, statusForPhase } from "../src/trade-jobs/trade-job-state";

describe("trade job state machine", () => {
  it("maps execution phases to persistent job states", () => {
    expect(statusForPhase("ARMED")).toBe("ARMED");
    expect(statusForPhase("ACCEPTED")).toBe("SUBMITTED");
    expect(statusForPhase("PREFLIGHT_REJECTED")).toBe("REJECTED");
    expect(statusForPhase("ERROR")).toBeUndefined();
  });

  it("allows the normal execution path", () => {
    expect(canTransition("SYNCED", "ARMED")).toBe(true);
    expect(canTransition("ARMED", "SUBMITTED")).toBe(true);
    expect(canTransition("SUBMITTED", "FILLED")).toBe(true);
    expect(canTransition("FILLED", "CLOSED")).toBe(true);
  });

  it("allows forward recovery when an earlier HTTP report was lost", () => {
    expect(canTransition("SYNCED", "SUBMITTED")).toBe(true);
    expect(canTransition("SYNCED", "FILLED")).toBe(true);
  });

  it("rejects terminal-state regressions", () => {
    expect(canTransition("CLOSED", "SUBMITTED")).toBe(false);
    expect(canTransition("REJECTED", "ARMED")).toBe(false);
    expect(canTransition("MISSED", "FILLED")).toBe(false);
  });
});
