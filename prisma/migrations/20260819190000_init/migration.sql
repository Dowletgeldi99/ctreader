-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('PENDING', 'ONLINE', 'OFFLINE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AccountEnvironment" AS ENUM ('DEMO', 'REAL', 'CONTEST');

-- CreateEnum
CREATE TYPE "MarginMode" AS ENUM ('NETTING', 'HEDGING', 'EXCHANGE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EventImportance" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TradeDirection" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('MARKET', 'STRADDLE');

-- CreateEnum
CREATE TYPE "RiskMode" AS ENUM ('FIXED_LOT', 'RISK_PERCENT');

-- CreateEnum
CREATE TYPE "TradeJobStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SYNCED', 'ARMED', 'SUBMITTED', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'MANAGED', 'CLOSED', 'CANCELLED', 'EXPIRED', 'MISSED');

-- CreateEnum
CREATE TYPE "ExecutionPhase" AS ENUM ('SYNCED', 'ARMED', 'PREFLIGHT_REJECTED', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCELLED', 'CLOSED', 'MISSED', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "telegramUsername" TEXT,
    "firstName" TEXT,
    "languageCode" TEXT NOT NULL DEFAULT 'ru',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSettings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "realTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultRiskMode" "RiskMode" NOT NULL DEFAULT 'FIXED_LOT',
    "defaultFixedLot" DECIMAL(10,4) NOT NULL DEFAULT 0.01,
    "defaultRiskPercent" DECIMAL(5,2) NOT NULL DEFAULT 0.25,
    "defaultArmSeconds" INTEGER NOT NULL DEFAULT 10,
    "defaultMaxLatenessMs" INTEGER NOT NULL DEFAULT 1000,
    "defaultDeviationPoints" INTEGER NOT NULL DEFAULT 20,
    "defaultMaxSpreadPoints" INTEGER NOT NULL DEFAULT 50,
    "maxDailyLossPercent" DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    "maxConcurrentJobs" INTEGER NOT NULL DEFAULT 1,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 900,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'PENDING',
    "version" TEXT,
    "terminalBuild" INTEGER,
    "serverUtcOffsetSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastIp" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "login" BIGINT NOT NULL,
    "broker" TEXT NOT NULL,
    "server" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "environment" "AccountEnvironment" NOT NULL,
    "marginMode" "MarginMode" NOT NULL DEFAULT 'UNKNOWN',
    "leverage" INTEGER,
    "balance" DECIMAL(20,2),
    "equity" DECIMAL(20,2),
    "tradeAllowed" BOOLEAN NOT NULL DEFAULT false,
    "expertTradeAllowed" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomicEvent" (
    "id" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MT5',
    "title" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "countryCode" TEXT,
    "importance" "EventImportance" NOT NULL DEFAULT 'UNKNOWN',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "forecast" DECIMAL(30,10),
    "previous" DECIMAL(30,10),
    "actual" DECIMAL(30,10),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EconomicEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeJob" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "economicEventId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" "TradeDirection" NOT NULL,
    "executionMode" "ExecutionMode" NOT NULL DEFAULT 'MARKET',
    "riskMode" "RiskMode" NOT NULL,
    "fixedLot" DECIMAL(10,4),
    "riskPercent" DECIMAL(5,2),
    "stopLossPoints" INTEGER NOT NULL,
    "takeProfitPoints" INTEGER NOT NULL,
    "deviationPoints" INTEGER NOT NULL DEFAULT 20,
    "maxSpreadPoints" INTEGER NOT NULL DEFAULT 50,
    "armSeconds" INTEGER NOT NULL DEFAULT 10,
    "maxLatenessMs" INTEGER NOT NULL DEFAULT 1000,
    "executeAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "TradeJobStatus" NOT NULL DEFAULT 'DRAFT',
    "settingsSnapshot" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "syncedAt" TIMESTAMP(3),
    "armedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "filledAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionReport" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "reportKey" TEXT NOT NULL,
    "phase" "ExecutionPhase" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "orderTicket" TEXT,
    "dealTicket" TEXT,
    "retcode" INTEGER,
    "message" TEXT,
    "requestedPrice" DECIMAL(30,10),
    "filledPrice" DECIMAL(30,10),
    "filledVolume" DECIMAL(10,4),
    "spreadPoints" INTEGER,
    "latencyMs" INTEGER,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramSession_userId_key" ON "TelegramSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserSettings_userId_key" ON "UserSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PairingCode_codeHash_key" ON "PairingCode"("codeHash");

-- CreateIndex
CREATE INDEX "PairingCode_userId_expiresAt_idx" ON "PairingCode"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_deviceId_key" ON "Agent"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_tokenHash_key" ON "Agent"("tokenHash");

-- CreateIndex
CREATE INDEX "Agent_userId_status_idx" ON "Agent"("userId", "status");

-- CreateIndex
CREATE INDEX "TradingAccount_userId_idx" ON "TradingAccount"("userId");

-- CreateIndex
CREATE INDEX "TradingAccount_agentId_idx" ON "TradingAccount"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccount_login_server_key" ON "TradingAccount"("login", "server");

-- CreateIndex
CREATE INDEX "EconomicEvent_currency_importance_scheduledAt_idx" ON "EconomicEvent"("currency", "importance", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "EconomicEvent_source_externalId_scheduledAt_key" ON "EconomicEvent"("source", "externalId", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeJob_idempotencyKey_key" ON "TradeJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TradeJob_accountId_status_executeAt_idx" ON "TradeJob"("accountId", "status", "executeAt");

-- CreateIndex
CREATE INDEX "TradeJob_userId_createdAt_idx" ON "TradeJob"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionReport_reportKey_key" ON "ExecutionReport"("reportKey");

-- CreateIndex
CREATE INDEX "ExecutionReport_jobId_occurredAt_idx" ON "ExecutionReport"("jobId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "TelegramSession" ADD CONSTRAINT "TelegramSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingCode" ADD CONSTRAINT "PairingCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeJob" ADD CONSTRAINT "TradeJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeJob" ADD CONSTRAINT "TradeJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeJob" ADD CONSTRAINT "TradeJob_economicEventId_fkey" FOREIGN KEY ("economicEventId") REFERENCES "EconomicEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionReport" ADD CONSTRAINT "ExecutionReport_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "TradeJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionReport" ADD CONSTRAINT "ExecutionReport_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
