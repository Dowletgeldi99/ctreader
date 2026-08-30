import type { ExecutionPhase, TradeJobStatus } from "../generated/prisma/client";

const phaseStatus: Record<ExecutionPhase, TradeJobStatus | undefined> = {
  SYNCED: "SYNCED",
  ARMED: "ARMED",
  PREFLIGHT_REJECTED: "REJECTED",
  SUBMITTED: "SUBMITTED",
  ACCEPTED: "SUBMITTED",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
  CLOSED: "CLOSED",
  MISSED: "MISSED",
  ERROR: undefined,
};

const transitions: Record<TradeJobStatus, ReadonlySet<TradeJobStatus>> = {
  DRAFT: new Set(["SCHEDULED", "CANCELLED"]),
  SCHEDULED: new Set(["SYNCED", "ARMED", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "EXPIRED", "MISSED", "REJECTED"]),
  SYNCED: new Set(["ARMED", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "EXPIRED", "MISSED", "REJECTED"]),
  ARMED: new Set(["SUBMITTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "MISSED", "REJECTED"]),
  SUBMITTED: new Set(["PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "CLOSED"]),
  PARTIALLY_FILLED: new Set(["FILLED", "MANAGED", "CLOSED", "CANCELLED"]),
  FILLED: new Set(["MANAGED", "CLOSED"]),
  REJECTED: new Set(),
  MANAGED: new Set(["CLOSED"]),
  CLOSED: new Set(),
  CANCELLED: new Set(),
  EXPIRED: new Set(),
  MISSED: new Set(),
};

export function statusForPhase(phase: ExecutionPhase): TradeJobStatus | undefined {
  return phaseStatus[phase];
}

export function canTransition(current: TradeJobStatus, next: TradeJobStatus): boolean {
  return current === next || transitions[current].has(next);
}
