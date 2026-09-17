ALTER TYPE "StrategyTimeframe" ADD VALUE IF NOT EXISTS 'M5';

UPDATE "StrategyConfig"
SET
  "emaFastPeriod" = 20,
  "emaSlowPeriod" = 50,
  "minEmaSeparationAtr" = 0.10,
  "minEmaSlopeAtr" = 0.005,
  "minBreakoutBodyRatio" = 0.55,
  "minBreakoutCloseAtr" = 0.05,
  "maxOppositeWickRatio" = 0.40,
  "maxBreakoutRangeAtr" = 5.00,
  "minTickVolumeRatio" = 0.80,
  "candidateLabelHorizonBars" = 36;
