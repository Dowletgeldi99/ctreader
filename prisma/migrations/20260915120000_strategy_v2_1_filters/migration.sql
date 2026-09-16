ALTER TABLE "StrategyConfig"
  ADD COLUMN "regimeFilterEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "minEmaSeparationAtr" DECIMAL(6,4) NOT NULL DEFAULT 0.15,
  ADD COLUMN "minEmaSlopeAtr" DECIMAL(6,4) NOT NULL DEFAULT 0.01,
  ADD COLUMN "minBreakoutBodyRatio" DECIMAL(6,4) NOT NULL DEFAULT 0.55,
  ADD COLUMN "minBreakoutCloseAtr" DECIMAL(6,4) NOT NULL DEFAULT 0.10,
  ADD COLUMN "maxOppositeWickRatio" DECIMAL(6,4) NOT NULL DEFAULT 0.35,
  ADD COLUMN "maxBreakoutRangeAtr" DECIMAL(6,4) NOT NULL DEFAULT 2.50,
  ADD COLUMN "minTickVolumeRatio" DECIMAL(6,4) NOT NULL DEFAULT 0.80,
  ADD COLUMN "newsGuardEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "newsGuardBeforeMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "newsGuardAfterMinutes" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "candidateLabelHorizonBars" INTEGER NOT NULL DEFAULT 16;

ALTER TABLE "MarketCandle"
  ALTER COLUMN "spreadPoints" DROP NOT NULL,
  ALTER COLUMN "spreadPoints" DROP DEFAULT,
  ADD COLUMN "tickVolume" DECIMAL(30,4),
  ADD COLUMN "isHistorical" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "StrategyCandidate" (
  "id" UUID NOT NULL,
  "strategyConfigId" UUID NOT NULL,
  "symbol" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "candleTime" TIMESTAMP(3) NOT NULL,
  "direction" "TradeDirection" NOT NULL,
  "regime" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "features" JSONB NOT NULL,
  "entryPrice" DECIMAL(30,10) NOT NULL,
  "stopLossPrice" DECIMAL(30,10) NOT NULL,
  "takeProfitPrice" DECIMAL(30,10) NOT NULL,
  "labelExpiresAt" TIMESTAMP(3) NOT NULL,
  "outcome" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StrategyCandidate_strategyConfigId_source_candleTime_key"
  ON "StrategyCandidate"("strategyConfigId", "source", "candleTime");
CREATE INDEX "StrategyCandidate_symbol_candleTime_idx"
  ON "StrategyCandidate"("symbol", "candleTime");
CREATE INDEX "StrategyCandidate_decision_createdAt_idx"
  ON "StrategyCandidate"("decision", "createdAt");

ALTER TABLE "StrategyCandidate" ADD CONSTRAINT "StrategyCandidate_strategyConfigId_fkey"
  FOREIGN KEY ("strategyConfigId") REFERENCES "StrategyConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
