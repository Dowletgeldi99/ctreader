import { describe, expect, it } from "vitest";
import { protectionPrice, reversalTargetsAfter } from "../src/ctrader/news-reversal-state";

describe("NEWS REVERSAL state math", () => {
  it("moves BUY protection from initial SL to TP1 and TP2 buffers", () => {
    expect(protectionPrice({ direction: "BUY", entryPrice: 4505, stopDistance: 1 })).toBe(4504);
    expect(protectionPrice({ direction: "BUY", entryPrice: 4505, stopDistance: 1,
      reachedTakeProfitPrice: 4515, bufferDistance: 2 })).toBe(4513);
    expect(protectionPrice({ direction: "BUY", entryPrice: 4505, stopDistance: 1,
      reachedTakeProfitPrice: 4525, bufferDistance: 2 })).toBe(4523);
  });

  it("mirrors protection for SELL", () => {
    expect(protectionPrice({ direction: "SELL", entryPrice: 4495, stopDistance: 1 })).toBe(4496);
    expect(protectionPrice({ direction: "SELL", entryPrice: 4495, stopDistance: 1,
      reachedTakeProfitPrice: 4485, bufferDistance: 2 })).toBe(4487);
  });

  it("reduces reversal targets after each take profit", () => {
    expect(reversalTargetsAfter(0, [100, 200, 300])).toEqual([100, 200, 300]);
    expect(reversalTargetsAfter(1, [100, 200, 300])).toEqual([100, 200]);
    expect(reversalTargetsAfter(2, [100, 200, 300])).toEqual([100]);
    expect(reversalTargetsAfter(3, [100, 200, 300])).toEqual([]);
  });
});
