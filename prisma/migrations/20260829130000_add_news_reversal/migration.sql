ALTER TYPE "ExecutionMode" ADD VALUE 'NEWS_REVERSAL';

CREATE TYPE "VolumeAllocationMode" AS ENUM ('SPLIT_TOTAL', 'FULL_EACH');
CREATE TYPE "NewsReversalState" AS ENUM (
  'WAITING_INITIAL_FILL',
  'INITIAL_BUY_ACTIVE',
  'INITIAL_SELL_ACTIVE',
  'TP1_PROTECTED',
  'TP2_PROTECTED',
  'REVERSAL_ACTIVE',
  'COMPLETED'
);
CREATE TYPE "TradeJobLegPurpose" AS ENUM ('INITIAL', 'REVERSAL');
CREATE TYPE "TradeJobLegStatus" AS ENUM (
  'PLANNED', 'SUBMITTED', 'FILLED', 'CANCELLED',
  'CLOSED_TP', 'CLOSED_SL', 'CLOSED_MANUAL', 'REJECTED'
);

ALTER TABLE "UserSettings"
  ADD COLUMN "reversalVolumeMode" "VolumeAllocationMode" NOT NULL DEFAULT 'SPLIT_TOTAL',
  ADD COLUMN "reversalEntryPips" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "reversalSlPips" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "reversalTp1Pips" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "reversalTp2Pips" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "reversalTp3Pips" INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN "reversalTp1BufferPips" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "reversalTp2BufferPips" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "reversalPendingExpirySeconds" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "reversalManagementSeconds" INTEGER NOT NULL DEFAULT 300;

ALTER TABLE "TradeJob"
  ADD COLUMN "volumeAllocationMode" "VolumeAllocationMode",
  ADD COLUMN "takeProfit2Points" INTEGER,
  ADD COLUMN "takeProfit3Points" INTEGER,
  ADD COLUMN "reversalTp1BufferPoints" INTEGER,
  ADD COLUMN "reversalTp2BufferPoints" INTEGER,
  ADD COLUMN "maxReversals" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "reversalCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "newsReversalState" "NewsReversalState",
  ADD COLUMN "activeDirection" "TradeDirection",
  ADD COLUMN "managementExpiresAt" TIMESTAMP(3);
ALTER TABLE "TradeJob"
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "closeRequestedAt" TIMESTAMP(3);

CREATE TABLE "TradeJobLeg" (
  "id" UUID NOT NULL,
  "jobId" UUID NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "legNumber" INTEGER NOT NULL,
  "direction" "TradeDirection" NOT NULL,
  "purpose" "TradeJobLegPurpose" NOT NULL,
  "targetNumber" INTEGER NOT NULL,
  "plannedVolume" DECIMAL(10,4) NOT NULL,
  "filledVolume" DECIMAL(10,4),
  "entryPrice" DECIMAL(30,10),
  "stopLossPrice" DECIMAL(30,10),
  "takeProfitPrice" DECIMAL(30,10),
  "brokerOrderId" TEXT,
  "brokerPositionId" TEXT,
  "status" "TradeJobLegStatus" NOT NULL DEFAULT 'PLANNED',
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TradeJobLeg_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TradeJobLeg_jobId_purpose_direction_targetNumber_revision_key"
  ON "TradeJobLeg"("jobId", "purpose", "direction", "targetNumber", "revision");
CREATE INDEX "TradeJobLeg_jobId_status_idx" ON "TradeJobLeg"("jobId", "status");
CREATE INDEX "TradeJobLeg_brokerOrderId_idx" ON "TradeJobLeg"("brokerOrderId");
CREATE INDEX "TradeJobLeg_brokerPositionId_idx" ON "TradeJobLeg"("brokerPositionId");

ALTER TABLE "TradeJobLeg"
  ADD CONSTRAINT "TradeJobLeg_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "TradeJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
