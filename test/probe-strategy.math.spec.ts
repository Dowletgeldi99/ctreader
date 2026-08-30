import { describe, expect, it } from "vitest";
import { atr, breakoutLevel, CandleValue, ema } from "../src/strategy-v2/probe-strategy.math";

function candles(closes: number[]): CandleValue[] {
  return closes.map((close, index) => ({
    openTime: new Date(index * 60_000),
    open: close - 0.1,
    high: close + 0.5,
    low: close - 0.5,
    close,
    spreadPoints: 10,
  }));
}

describe("Probe Strategy V2 math", () => {
  it("detects an upward EMA regime", () => {
    const closes = Array.from({ length: 220 }, (_, index) => 2_000 + index);
    expect(ema(closes, 50)).toBeGreaterThan(ema(closes, 200));
  });

  it("calculates ATR from true ranges", () => {
    expect(atr(candles([100, 101, 102, 103]), 3)).toBeCloseTo(1.5);
  });

  it("uses only the configured breakout window", () => {
    const values = candles([100, 101, 102, 103, 104]);
    expect(breakoutLevel(values, 3, "BUY")).toBe(104.5);
    expect(breakoutLevel(values, 3, "SELL")).toBe(101.5);
  });
});
