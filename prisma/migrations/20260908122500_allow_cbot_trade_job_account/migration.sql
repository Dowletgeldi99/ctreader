ALTER TABLE "TradeJob"
DROP CONSTRAINT "TradeJob_exactly_one_account_check";

ALTER TABLE "TradeJob"
ADD CONSTRAINT "TradeJob_exactly_one_account_check" CHECK (
  (
    "executionVenue" = 'MT5'
    AND "accountId" IS NOT NULL
    AND "cTraderAccountId" IS NULL
    AND "cbotInstanceId" IS NULL
  )
  OR
  (
    "executionVenue" = 'CTRADER'
    AND "accountId" IS NULL
    AND "cTraderAccountId" IS NOT NULL
    AND "cbotInstanceId" IS NULL
  )
  OR
  (
    "executionVenue" = 'CBOT'
    AND "accountId" IS NULL
    AND "cTraderAccountId" IS NULL
    AND "cbotInstanceId" IS NOT NULL
  )
);
