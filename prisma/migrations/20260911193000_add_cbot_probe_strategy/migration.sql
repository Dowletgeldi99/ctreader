ALTER TABLE "StrategyConfig" ADD COLUMN "cbotInstanceId" UUID;
ALTER TABLE "StrategyPosition" ADD COLUMN "cbotInstanceId" UUID;

ALTER TABLE "StrategyConfig" DROP CONSTRAINT "StrategyConfig_exactly_one_account_check";
ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_exactly_one_account_check" CHECK (
  ("executionVenue" = 'MT5' AND "accountId" IS NOT NULL AND "cTraderAccountId" IS NULL AND "cbotInstanceId" IS NULL)
  OR ("executionVenue" = 'CTRADER' AND "accountId" IS NULL AND "cTraderAccountId" IS NOT NULL AND "cbotInstanceId" IS NULL)
  OR ("executionVenue" = 'CBOT' AND "accountId" IS NULL AND "cTraderAccountId" IS NULL AND "cbotInstanceId" IS NOT NULL)
);

ALTER TABLE "StrategyPosition" DROP CONSTRAINT "StrategyPosition_exactly_one_account_check";
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_exactly_one_account_check" CHECK (
  ("executionVenue" = 'MT5' AND "accountId" IS NOT NULL AND "cTraderAccountId" IS NULL AND "cbotInstanceId" IS NULL)
  OR ("executionVenue" = 'CTRADER' AND "accountId" IS NULL AND "cTraderAccountId" IS NOT NULL AND "cbotInstanceId" IS NULL)
  OR ("executionVenue" = 'CBOT' AND "accountId" IS NULL AND "cTraderAccountId" IS NULL AND "cbotInstanceId" IS NOT NULL)
);

CREATE UNIQUE INDEX "StrategyConfig_userId_cbotInstanceId_symbol_key"
  ON "StrategyConfig"("userId", "cbotInstanceId", "symbol");

ALTER TABLE "StrategyConfig" ADD CONSTRAINT "StrategyConfig_cbotInstanceId_fkey"
  FOREIGN KEY ("cbotInstanceId") REFERENCES "CbotInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StrategyPosition" ADD CONSTRAINT "StrategyPosition_cbotInstanceId_fkey"
  FOREIGN KEY ("cbotInstanceId") REFERENCES "CbotInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
