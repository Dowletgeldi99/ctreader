export function calculateRiskVolumeInCents(input: {
  balance: number; riskPercent: number; totalStopDistance: number;
  minVolume: number; maxVolume: number; stepVolume: number;
}): number {
  if (input.balance <= 0 || input.riskPercent <= 0 || input.totalStopDistance <= 0 || input.stepVolume <= 0)
    throw new Error("Invalid cTrader risk calculation input");
  const riskMoney = input.balance * input.riskPercent / 100;
  const rawCents = (riskMoney / input.totalStopDistance) * 100;
  const volume = Math.floor(rawCents / input.stepVolume) * input.stepVolume;
  if (volume < input.minVolume) throw new Error("Calculated risk volume is below the broker minimum");
  if (volume > input.maxVolume) throw new Error("Calculated volume exceeds the broker maximum");
  return volume;
}
