export type NewsReversalVolumeMode = "SPLIT_TOTAL" | "FULL_EACH";

export interface VolumeAllocation {
  legs: number[];
  total: number;
}

/** Allocates broker integer volume units while preserving the requested total. */
export function allocateNewsReversalVolume(
  requestedUnits: number,
  stepUnits: number,
  mode: NewsReversalVolumeMode,
  targets = 3,
): VolumeAllocation {
  if (!Number.isSafeInteger(requestedUnits) || requestedUnits <= 0)
    throw new Error("Requested volume must be a positive integer");
  if (!Number.isSafeInteger(stepUnits) || stepUnits <= 0)
    throw new Error("Volume step must be a positive integer");
  if (!Number.isInteger(targets) || targets < 1)
    throw new Error("Target count must be positive");

  const normalized = Math.floor(requestedUnits / stepUnits) * stepUnits;
  if (normalized <= 0) throw new Error("Requested volume is below the broker step");

  if (mode === "FULL_EACH") {
    return { legs: Array.from({ length: targets }, () => normalized), total: normalized * targets };
  }

  const totalSteps = normalized / stepUnits;
  if (totalSteps < targets)
    throw new Error(`Total volume is too small to split into ${targets} broker-valid positions`);
  const baseSteps = Math.floor(totalSteps / targets);
  const remainder = totalSteps - baseSteps * targets;
  const legs = Array.from({ length: targets }, (_, index) =>
    (baseSteps + (index >= targets - remainder ? 1 : 0)) * stepUnits,
  );
  return { legs, total: legs.reduce((sum, value) => sum + value, 0) };
}

