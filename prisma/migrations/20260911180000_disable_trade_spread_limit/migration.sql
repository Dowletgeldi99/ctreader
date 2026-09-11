ALTER TABLE "UserSettings"
  ALTER COLUMN "defaultMaxSpreadPoints" SET DEFAULT 0;

ALTER TABLE "TradeJob"
  ALTER COLUMN "maxSpreadPoints" SET DEFAULT 0;

UPDATE "UserSettings"
SET "defaultMaxSpreadPoints" = 0;

UPDATE "TradeJob"
SET "maxSpreadPoints" = 0
WHERE "status" IN ('DRAFT', 'SCHEDULED', 'SYNCED', 'ARMED');
