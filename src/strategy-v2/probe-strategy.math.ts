export interface CandleValue {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  spreadPoints?: number;
  tickVolume?: number;
}

export type MarketRegime = "TREND_UP" | "TREND_DOWN" | "RANGE" | "HIGH_VOL";

export interface RegimeResult {
  regime: Exclude<MarketRegime, "HIGH_VOL">;
  emaFast: number;
  emaSlow: number;
  separationAtr: number;
  slopeAtr: number;
  atr: number;
}

export interface BreakoutQualityResult {
  accepted: boolean;
  reasons: string[];
  rangeAtr: number;
  bodyRatio: number;
  oppositeWickRatio: number;
  closeBeyondAtr: number;
  tickVolumeRatio?: number;
}

export function detectM5Trigger(input: {
  bias: "BUY" | "SELL";
  previous: CandleValue;
  current: CandleValue;
  buyLevel: number;
  sellLevel: number;
  atr: number;
}): { direction: "BUY" | "SELL"; trigger: "FAST_BREAKOUT" | "RETEST"; level: number } | undefined {
  if (input.bias === "BUY") {
    const breakout = input.previous.close <= input.buyLevel && input.current.close > input.buyLevel;
    const retest = input.previous.close > input.buyLevel
      && input.current.low <= input.buyLevel + 0.15 * input.atr
      && input.current.close > input.buyLevel && input.current.close > input.current.open;
    if (breakout || retest) return { direction: "BUY", trigger: retest ? "RETEST" : "FAST_BREAKOUT",
      level: input.buyLevel };
  } else {
    const breakout = input.previous.close >= input.sellLevel && input.current.close < input.sellLevel;
    const retest = input.previous.close < input.sellLevel
      && input.current.high >= input.sellLevel - 0.15 * input.atr
      && input.current.close < input.sellLevel && input.current.close < input.current.open;
    if (breakout || retest) return { direction: "SELL", trigger: retest ? "RETEST" : "FAST_BREAKOUT",
      level: input.sellLevel };
  }
  return undefined;
}

export function resolveBarrierOutcome(input: {
  direction: "BUY" | "SELL";
  stopLoss: number;
  takeProfit: number;
  candle: CandleValue;
}): "TP" | "SL" | undefined {
  const stopHit = input.direction === "BUY"
    ? input.candle.low <= input.stopLoss
    : input.candle.high >= input.stopLoss;
  const targetHit = input.direction === "BUY"
    ? input.candle.high >= input.takeProfit
    : input.candle.low <= input.takeProfit;
  // OHLC does not reveal intrabar ordering. Resolve an ambiguous bar conservatively as SL.
  if (stopHit) return "SL";
  if (targetHit) return "TP";
  return undefined;
}

export function ema(values: number[], period: number): number {
  if (values.length < period) throw new Error(`EMA ${period} requires at least ${period} values`);
  const alpha = 2 / (period + 1);
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  for (const value of values.slice(period)) result = value * alpha + result * (1 - alpha);
  return result;
}

export function atr(candles: CandleValue[], period: number): number {
  if (candles.length < period + 1) throw new Error(`ATR ${period} requires at least ${period + 1} candles`);
  const ranges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return ranges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

export function breakoutLevel(candles: CandleValue[], period: number, direction: "BUY" | "SELL"): number {
  const window = candles.slice(-period);
  if (window.length < period) throw new Error(`Breakout ${period} requires ${period} candles`);
  return direction === "BUY"
    ? Math.max(...window.map((candle) => candle.high))
    : Math.min(...window.map((candle) => candle.low));
}

export function median(values: number[]): number {
  if (values.length === 0) throw new Error("Median requires at least one value");
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

export function detectMarketRegime(
  candles: CandleValue[],
  fastPeriod: number,
  slowPeriod: number,
  atrPeriod: number,
  minSeparationAtr: number,
  minSlopeAtr: number,
  slopeBars = 3,
): RegimeResult {
  if (candles.length < Math.max(slowPeriod + slopeBars, atrPeriod + 1)) {
    throw new Error("Market regime requires more candles");
  }
  const closes = candles.map((candle) => candle.close);
  const emaFast = ema(closes, fastPeriod);
  const emaSlow = ema(closes, slowPeriod);
  const previousFast = ema(closes.slice(0, -slopeBars), fastPeriod);
  const currentAtr = atr(candles, atrPeriod);
  if (currentAtr <= 0) throw new Error("Market regime ATR must be positive");
  const separationAtr = Math.abs(emaFast - emaSlow) / currentAtr;
  const slopeAtr = (emaFast - previousFast) / currentAtr / slopeBars;
  let regime: RegimeResult["regime"] = "RANGE";
  if (separationAtr >= minSeparationAtr && Math.abs(slopeAtr) >= minSlopeAtr) {
    if (emaFast > emaSlow && slopeAtr > 0) regime = "TREND_UP";
    if (emaFast < emaSlow && slopeAtr < 0) regime = "TREND_DOWN";
  }
  return { regime, emaFast, emaSlow, separationAtr, slopeAtr, atr: currentAtr };
}

export function assessBreakoutQuality(input: {
  candle: CandleValue;
  direction: "BUY" | "SELL";
  level: number;
  atr: number;
  previousTickVolumes: number[];
  minBodyRatio: number;
  minCloseBeyondAtr: number;
  maxOppositeWickRatio: number;
  maxRangeAtr: number;
  minTickVolumeRatio: number;
}): BreakoutQualityResult {
  const { candle, direction } = input;
  const range = candle.high - candle.low;
  if (range <= 0 || input.atr <= 0) {
    return { accepted: false, reasons: ["INVALID_RANGE"], rangeAtr: 0, bodyRatio: 0,
      oppositeWickRatio: 0, closeBeyondAtr: 0 };
  }
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  const oppositeWick = direction === "BUY"
    ? candle.high - Math.max(candle.open, candle.close)
    : Math.min(candle.open, candle.close) - candle.low;
  const oppositeWickRatio = Math.max(0, oppositeWick) / range;
  const closeBeyond = direction === "BUY" ? candle.close - input.level : input.level - candle.close;
  const closeBeyondAtr = closeBeyond / input.atr;
  const rangeAtr = range / input.atr;
  const usableVolumes = input.previousTickVolumes.filter((value) => Number.isFinite(value) && value > 0);
  const baselineVolume = usableVolumes.length > 0 ? median(usableVolumes) : undefined;
  const tickVolumeRatio = candle.tickVolume !== undefined && baselineVolume ? candle.tickVolume / baselineVolume : undefined;
  const reasons: string[] = [];
  if ((direction === "BUY" && candle.close <= candle.open) || (direction === "SELL" && candle.close >= candle.open)) {
    reasons.push("WRONG_BODY_DIRECTION");
  }
  if (bodyRatio < input.minBodyRatio) reasons.push("WEAK_BODY");
  if (oppositeWickRatio > input.maxOppositeWickRatio) reasons.push("LARGE_REJECTION_WICK");
  if (closeBeyondAtr < input.minCloseBeyondAtr) reasons.push("WEAK_CLOSE_BEYOND_LEVEL");
  if (rangeAtr > input.maxRangeAtr) reasons.push("HIGH_VOL_BREAKOUT");
  if (tickVolumeRatio !== undefined && tickVolumeRatio < input.minTickVolumeRatio) reasons.push("LOW_TICK_VOLUME");
  return { accepted: reasons.length === 0, reasons, rangeAtr, bodyRatio, oppositeWickRatio,
    closeBeyondAtr, tickVolumeRatio };
}
