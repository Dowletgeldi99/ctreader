ALTER TABLE "StrategyConfig" ALTER COLUMN "cTraderAccountId" DROP NOT NULL;
ALTER TABLE "StrategyConfig" ADD COLUMN "accountId" UUID;
ALTER TABLE "StrategyConfig" ADD COLUMN "executionVenue" "ExecutionVenue" NOT NULL DEFAULT 'CTRADER';

ALTER TABLE "StrategyPosition" ALTER COLUMN "cTraderAccountId" DROP NOT NULL;
ALTER TABLE "StrategyPosition" ADD COLUMN "accountId" UUID;
ALTER TABLE "StrategyPosition" ADD COLUMN "executionVenue" "ExecutionVenue" NOT NULL DEFAULT 'CTRADER';

CREATE UNIQUE INDEX "StrategyConfig_userId_accountId_symbol_key" ON "StrategyConfig"("userId", "accountId", "symbol");
ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_exactly_one_account_check" CHECK (
  ("executionVenue" = 'MT5' AND "accountId" IS NOT NULL AND "cTraderAccountId" IS NULL)
  OR ("executionVenue" = 'CTRADER' AND "accountId" IS NULL AND "cTraderAccountId" IS NOT NULL)
);
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_exactly_one_account_check" CHECK (
  ("executionVenue" = 'MT5' AND "accountId" IS NOT NULL AND "cTraderAccountId" IS NULL)
  OR ("executionVenue" = 'CTRADER' AND "accountId" IS NULL AND "cTraderAccountId" IS NOT NULL)
);
