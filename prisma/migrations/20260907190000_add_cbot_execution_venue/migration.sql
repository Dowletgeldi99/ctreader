ALTER TYPE "ExecutionVenue" ADD VALUE 'CBOT';

ALTER TABLE "TradeJob" ADD COLUMN "cbotInstanceId" UUID;

CREATE INDEX "TradeJob_cbotInstanceId_status_executeAt_idx"
ON "TradeJob"("cbotInstanceId", "status", "executeAt");

ALTER TABLE "TradeJob"
ADD CONSTRAINT "TradeJob_cbotInstanceId_fkey"
FOREIGN KEY ("cbotInstanceId") REFERENCES "CbotInstance"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
