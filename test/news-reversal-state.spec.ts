import { describe, expect, it } from "vitest";
import { fixedReversalPrice, reversalTargetsAfter } from "../src/ctrader/news-reversal-state";

describe("NEWS REVERSAL state math", () => {
  it("places BUY reversal beyond the initial SL", () => {
    expect(fixedReversalPrice({ direction: "BUY", entryPrice: 4505, stopDistance: 1, reversalGap: 1 })).toBe(4503);
  });

  it("mirrors fixed reversal for SELL", () => {
    expect(fixedReversalPrice({ direction: "SELL", entryPrice: 4495, stopDistance: 1, reversalGap: 1 })).toBe(4497);
  });

  it("reduces reversal targets after each take profit", () => {
    expect(reversalTargetsAfter(0, [100, 200, 300])).toEqual([100, 200, 300]);
    expect(reversalTargetsAfter(1, [100, 200, 300])).toEqual([100, 200]);
    expect(reversalTargetsAfter(2, [100, 200, 300])).toEqual([100]);
    expect(reversalTargetsAfter(3, [100, 200, 300])).toEqual([]);
  });
});
