ALTER TABLE "UserSettings"
  ADD COLUMN "reversalGapPips" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "TradeJob"
  ADD COLUMN "reversalGapPoints" INTEGER;
