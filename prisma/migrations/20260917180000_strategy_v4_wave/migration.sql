UPDATE "StrategyConfig"
SET
  "emaFastPeriod" = 8,
  "emaSlowPeriod" = 21,
  "breakoutPeriod" = 6,
  "stopAtrMultiplier" = 1.30,
  "takeProfitR" = 2.50,
  "cooldownBars" = 1,
  "minEmaSeparationAtr" = 0.05,
  "minEmaSlopeAtr" = 0.005,
  "minBreakoutBodyRatio" = 0.50,
  "minBreakoutCloseAtr" = 0.05,
  "maxOppositeWickRatio" = 0.35,
  "maxBreakoutRangeAtr" = 2.20,
  "minTickVolumeRatio" = 0.90,
  "newsGuardBeforeMinutes" = 20,
  "newsGuardAfterMinutes" = 10,
  "candidateLabelHorizonBars" = 24;
