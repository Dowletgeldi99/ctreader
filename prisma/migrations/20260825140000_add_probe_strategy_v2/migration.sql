CREATE TYPE "StrategyTimeframe" AS ENUM ('M15', 'H1');
CREATE TYPE "StrategyPositionState" AS ENUM ('PROBE_OPEN', 'MAIN_ADDED', 'CLOSED_TP', 'CLOSED_SL', 'CLOSED_TIMEOUT');

CREATE TABLE "StrategyConfig" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "cTraderAccountId" UUID NOT NULL,
  "symbol" TEXT NOT NULL DEFAULT 'XAUUSD', "enabled" BOOLEAN NOT NULL DEFAULT false,
  "probeRiskPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.10,
  "mainRiskPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.30,
  "emaFastPeriod" INTEGER NOT NULL DEFAULT 50, "emaSlowPeriod" INTEGER NOT NULL DEFAULT 200,
  "breakoutPeriod" INTEGER NOT NULL DEFAULT 20, "atrPeriod" INTEGER NOT NULL DEFAULT 14,
  "stopAtrMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1.20,
  "takeProfitR" DECIMAL(5,2) NOT NULL DEFAULT 3.00,
  "maxSpreadPoints" INTEGER NOT NULL DEFAULT 50, "confirmationBars" INTEGER NOT NULL DEFAULT 3,
  "cooldownBars" INTEGER NOT NULL DEFAULT 4, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "StrategyConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StrategyPosition" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "cTraderAccountId" UUID NOT NULL,
  "strategyConfigId" UUID NOT NULL, "symbol" TEXT NOT NULL, "direction" "TradeDirection" NOT NULL,
  "state" "StrategyPositionState" NOT NULL, "breakoutLevel" DECIMAL(30,10) NOT NULL,
  "atrAtEntry" DECIMAL(30,10) NOT NULL, "probeEntryPrice" DECIMAL(30,10) NOT NULL,
  "mainEntryPrice" DECIMAL(30,10), "stopLossPrice" DECIMAL(30,10) NOT NULL,
  "takeProfitPrice" DECIMAL(30,10) NOT NULL, "probeRiskPercent" DECIMAL(5,2) NOT NULL,
  "mainRiskPercent" DECIMAL(5,2) NOT NULL, "confirmationDeadline" TIMESTAMP(3) NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL, "mainAddedAt" TIMESTAMP(3), "closedAt" TIMESTAMP(3),
  "closePrice" DECIMAL(30,10), "closeReason" TEXT, "realizedR" DECIMAL(10,4),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StrategyPosition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StrategyEvent" (
  "id" UUID NOT NULL, "strategyPositionId" UUID NOT NULL, "type" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL, "price" DECIMAL(30,10), "message" TEXT NOT NULL,
  "metadata" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MarketCandle" (
  "id" UUID NOT NULL, "symbol" TEXT NOT NULL, "timeframe" "StrategyTimeframe" NOT NULL,
  "openTime" TIMESTAMP(3) NOT NULL, "open" DECIMAL(30,10) NOT NULL,
  "high" DECIMAL(30,10) NOT NULL, "low" DECIMAL(30,10) NOT NULL, "close" DECIMAL(30,10) NOT NULL,
  "spreadPoints" INTEGER NOT NULL DEFAULT 0, "source" TEXT NOT NULL DEFAULT 'MOCK',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketCandle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StrategyConfig_userId_cTraderAccountId_symbol_key" ON "StrategyConfig"("userId", "cTraderAccountId", "symbol");
CREATE INDEX "StrategyConfig_enabled_symbol_idx" ON "StrategyConfig"("enabled", "symbol");
CREATE INDEX "StrategyPosition_strategyConfigId_state_idx" ON "StrategyPosition"("strategyConfigId", "state");
CREATE INDEX "StrategyPosition_userId_createdAt_idx" ON "StrategyPosition"("userId", "createdAt");
CREATE INDEX "StrategyEvent_strategyPositionId_occurredAt_idx" ON "StrategyEvent"("strategyPositionId", "occurredAt");
CREATE UNIQUE INDEX "MarketCandle_symbol_timeframe_openTime_source_key" ON "MarketCandle"("symbol", "timeframe", "openTime", "source");
CREATE INDEX "MarketCandle_symbol_timeframe_openTime_idx" ON "MarketCandle"("symbol", "timeframe", "openTime");

ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_cTraderAccountId_fkey" FOREIGN KEY ("cTraderAccountId") REFERENCES "CTraderAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_cTraderAccountId_fkey" FOREIGN KEY ("cTraderAccountId") REFERENCES "CTraderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_strategyConfigId_fkey" FOREIGN KEY ("strategyConfigId") REFERENCES "StrategyConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StrategyEvent" ADD CONSTRAINT "StrategyEvent_strategyPositionId_fkey" FOREIGN KEY ("strategyPositionId") REFERENCES "StrategyPosition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
