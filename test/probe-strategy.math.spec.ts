import { describe, expect, it } from "vitest";
import { assessBreakoutQuality, atr, breakoutLevel, CandleValue, detectM5Trigger, detectMarketRegime, ema, resolveBarrierOutcome } from "../src/strategy-v2/probe-strategy.math";

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

describe("Strategy V3 math", () => {
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

  it("classifies aligned and rising averages as an uptrend", () => {
    const values = candles(Array.from({ length: 220 }, (_, index) => 2_000 + index * 0.5));
    const result = detectMarketRegime(values, 50, 200, 14, 0.15, 0.01);
    expect(result.regime).toBe("TREND_UP");
    expect(result.separationAtr).toBeGreaterThan(0.15);
    expect(result.slopeAtr).toBeGreaterThan(0.01);
  });

  it("classifies flat price action as a range", () => {
    const values = candles(Array.from({ length: 220 }, (_, index) => 2_000 + Math.sin(index) * 0.05));
    expect(detectMarketRegime(values, 50, 200, 14, 0.15, 0.01).regime).toBe("RANGE");
  });

  it("accepts a strong breakout with confirming tick volume", () => {
    const result = assessBreakoutQuality({
      candle: { openTime: new Date(), open: 100, high: 102.1, low: 99.8, close: 102, tickVolume: 150 },
      direction: "BUY", level: 101, atr: 2, previousTickVolumes: [90, 100, 110],
      minBodyRatio: 0.55, minCloseBeyondAtr: 0.1, maxOppositeWickRatio: 0.35,
      maxRangeAtr: 2.5, minTickVolumeRatio: 0.8,
    });
    expect(result.accepted).toBe(true);
    expect(result.tickVolumeRatio).toBe(1.5);
  });

  it("rejects a weak close with a large rejection wick", () => {
    const result = assessBreakoutQuality({
      candle: { openTime: new Date(), open: 100.8, high: 103, low: 100.5, close: 101.1, tickVolume: 50 },
      direction: "BUY", level: 101, atr: 2, previousTickVolumes: [100, 110, 120],
      minBodyRatio: 0.55, minCloseBeyondAtr: 0.1, maxOppositeWickRatio: 0.35,
      maxRangeAtr: 2.5, minTickVolumeRatio: 0.8,
    });
    expect(result.accepted).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["WEAK_BODY", "LARGE_REJECTION_WICK",
      "WEAK_CLOSE_BEYOND_LEVEL", "LOW_TICK_VOLUME"]));
  });

  it("rejects a breakout candle whose body points against the trade", () => {
    const result = assessBreakoutQuality({
      candle: { openTime: new Date(), open: 102, high: 102.1, low: 100.8, close: 101.2, tickVolume: 120 },
      direction: "BUY", level: 101, atr: 2, previousTickVolumes: [100, 110, 120],
      minBodyRatio: 0.55, minCloseBeyondAtr: 0.1, maxOppositeWickRatio: 0.35,
      maxRangeAtr: 2.5, minTickVolumeRatio: 0.8,
    });
    expect(result.reasons).toContain("WRONG_BODY_DIRECTION");
  });

  it("labels ambiguous OHLC barriers conservatively as a stop", () => {
    expect(resolveBarrierOutcome({ direction: "BUY", stopLoss: 99, takeProfit: 103,
      candle: { openTime: new Date(), open: 100, high: 104, low: 98, close: 102 } })).toBe("SL");
    expect(resolveBarrierOutcome({ direction: "SELL", stopLoss: 103, takeProfit: 99,
      candle: { openTime: new Date(), open: 102, high: 102.5, low: 98.5, close: 99 } })).toBe("TP");
  });

  it("detects an M5 breakout in the H1 bias direction", () => {
    const result = detectM5Trigger({ bias: "BUY", buyLevel: 101, sellLevel: 98, atr: 1,
      previous: { openTime: new Date(0), open: 100, high: 101, low: 99.5, close: 100.8 },
      current: { openTime: new Date(1), open: 100.8, high: 101.5, low: 100.7, close: 101.3 } });
    expect(result).toEqual({ direction: "BUY", trigger: "FAST_BREAKOUT", level: 101 });
  });

  it("detects an M5 retest after the level holds", () => {
    const result = detectM5Trigger({ bias: "SELL", buyLevel: 103, sellLevel: 100, atr: 1,
      previous: { openTime: new Date(0), open: 100, high: 100.1, low: 99.4, close: 99.6 },
      current: { openTime: new Date(1), open: 99.8, high: 100.1, low: 99.2, close: 99.4 } });
    expect(result).toEqual({ direction: "SELL", trigger: "RETEST", level: 100 });
  });
});
