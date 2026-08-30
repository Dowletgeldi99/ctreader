CREATE TYPE "ExecutionVenue" AS ENUM ('MT5', 'CTRADER');
CREATE TYPE "MockExecutionOutcome" AS ENUM ('BUY_FILL', 'SELL_FILL', 'TIMEOUT', 'REJECT');

ALTER TABLE "TradeJob" ALTER COLUMN "accountId" DROP NOT NULL;
ALTER TABLE "TradeJob"
  ADD COLUMN "cTraderAccountId" UUID,
  ADD COLUMN "executionVenue" "ExecutionVenue" NOT NULL DEFAULT 'MT5',
  ADD COLUMN "mockOutcome" "MockExecutionOutcome",
  ADD COLUMN "mockBid" DECIMAL(30,10),
  ADD COLUMN "mockAsk" DECIMAL(30,10),
  ADD COLUMN "mockSlippagePoints" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "ExecutionReport" ALTER COLUMN "agentId" DROP NOT NULL;
ALTER TABLE "ExecutionReport" ADD COLUMN "executionSource" TEXT NOT NULL DEFAULT 'MT5_AGENT';

ALTER TABLE "TradeJob" ADD CONSTRAINT "TradeJob_cTraderAccountId_fkey"
  FOREIGN KEY ("cTraderAccountId") REFERENCES "CTraderAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TradeJob" ADD CONSTRAINT "TradeJob_exactly_one_account_check" CHECK (
  ("executionVenue" = 'MT5' AND "accountId" IS NOT NULL AND "cTraderAccountId" IS NULL)
  OR
  ("executionVenue" = 'CTRADER' AND "accountId" IS NULL AND "cTraderAccountId" IS NOT NULL)
);

CREATE INDEX "TradeJob_cTraderAccountId_status_executeAt_idx"
  ON "TradeJob"("cTraderAccountId", "status", "executeAt");
