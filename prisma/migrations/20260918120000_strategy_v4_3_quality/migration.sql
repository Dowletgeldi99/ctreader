ALTER TABLE "StrategyConfig"
  ALTER COLUMN "minBreakoutBodyRatio" SET DEFAULT 0.55;

UPDATE "StrategyConfig"
SET
  "regimeFilterEnabled" = true,
  "minBreakoutBodyRatio" = 0.55,
  "minBreakoutCloseAtr" = 0.05,
  "maxOppositeWickRatio" = 0.35,
  "maxBreakoutRangeAtr" = 3.00,
  "minTickVolumeRatio" = 0.90;
