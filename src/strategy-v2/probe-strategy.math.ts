export interface CandleValue {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  spreadPoints: number;
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
