import { describe, expect, it } from "vitest";
import { calculateRiskVolumeInCents } from "../src/ctrader/ctrader-risk";

describe("cTrader risk volume", () => {
  it("allocates a basket-wide risk and rounds down to broker step", () => {
    expect(calculateRiskVolumeInCents({ balance: 10_000, riskPercent: 0.25, totalStopDistance: 6,
      minVolume: 1, maxVolume: 1_000_000, stepVolume: 1 })).toBe(416);
  });

  it("never raises a too-small risk to broker minimum", () => {
    expect(() => calculateRiskVolumeInCents({ balance: 1, riskPercent: 0.01, totalStopDistance: 10,
      minVolume: 100, maxVolume: 1_000_000, stepVolume: 100 })).toThrow(/below the broker minimum/);
  });
});
