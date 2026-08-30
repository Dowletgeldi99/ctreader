ALTER TABLE "TradeJob"
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "TradeJob_executionVenue_status_leaseExpiresAt_idx"
  ON "TradeJob"("executionVenue", "status", "leaseExpiresAt");

CREATE TABLE "SystemControl" (
  "id" TEXT NOT NULL,
  "tradingHalted" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemControl_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SystemControl" ("id", "tradingHalted", "updatedAt")
VALUES ('global', false, CURRENT_TIMESTAMP);
