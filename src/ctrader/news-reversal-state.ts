export type NewsDirection = "BUY" | "SELL";

export function reversalTargetsAfter(closedTargets: number, targets: number[]): number[] {
  if (!Number.isInteger(closedTargets) || closedTargets < 0 || closedTargets > targets.length)
    throw new Error("Invalid closed target count");
  return targets.slice(0, Math.max(0, targets.length - closedTargets));
}

export function fixedReversalPrice(input: {
  direction: NewsDirection;
  entryPrice: number;
  stopDistance: number;
  reversalGap: number;
}): number {
  const sign = input.direction === "BUY" ? -1 : 1;
  if (input.stopDistance <= 0) throw new Error("Stop distance must be positive");
  if (input.reversalGap <= 0) throw new Error("Reversal gap must be positive");
  return input.entryPrice + sign * (input.stopDistance + input.reversalGap);
}
