CREATE TYPE "SubscriptionPlanCode" AS ENUM ('TRIAL', 'BASIC', 'PRO');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'EXPIRED', 'CANCELED', 'SUSPENDED');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');
CREATE TYPE "CbotInstanceStatus" AS ENUM ('ONLINE', 'OFFLINE', 'REVOKED');

CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "code" "SubscriptionPlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "priceUsd" DECIMAL(10,2) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "marketEnabled" BOOLEAN NOT NULL DEFAULT true,
    "ocoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "multiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "newsReversalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "liveTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxAccounts" INTEGER NOT NULL DEFAULT 1,
    "maxLot" DECIMAL(10,4) NOT NULL DEFAULT 0.01,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionEntitlement" (
    "id" UUID NOT NULL,
    "subscriptionId" UUID NOT NULL,
    "marketEnabled" BOOLEAN NOT NULL,
    "ocoEnabled" BOOLEAN NOT NULL,
    "multiEnabled" BOOLEAN NOT NULL,
    "newsReversalEnabled" BOOLEAN NOT NULL,
    "liveTradingEnabled" BOOLEAN NOT NULL,
    "maxAccounts" INTEGER NOT NULL,
    "maxLot" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SubscriptionEntitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "subscriptionId" UUID,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "amountUsd" DECIMAL(10,2) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CbotPairingCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CbotPairingCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CbotInstance" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "instanceKey" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "accountNumber" BIGINT NOT NULL,
    "broker" TEXT NOT NULL,
    "environment" "CTraderAccountEnvironment" NOT NULL,
    "symbol" TEXT NOT NULL DEFAULT 'XAUUSD',
    "version" TEXT,
    "status" "CbotInstanceStatus" NOT NULL DEFAULT 'ONLINE',
    "lastIp" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CbotInstance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SubscriptionAuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subscriptionId" UUID,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SubscriptionAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");
CREATE INDEX "Subscription_userId_status_currentPeriodEnd_idx" ON "Subscription"("userId", "status", "currentPeriodEnd");
CREATE UNIQUE INDEX "SubscriptionEntitlement_subscriptionId_key" ON "SubscriptionEntitlement"("subscriptionId");
CREATE UNIQUE INDEX "Payment_provider_externalId_key" ON "Payment"("provider", "externalId");
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");
CREATE UNIQUE INDEX "CbotPairingCode_codeHash_key" ON "CbotPairingCode"("codeHash");
CREATE INDEX "CbotPairingCode_userId_expiresAt_idx" ON "CbotPairingCode"("userId", "expiresAt");
CREATE UNIQUE INDEX "CbotInstance_instanceKey_key" ON "CbotInstance"("instanceKey");
CREATE UNIQUE INDEX "CbotInstance_tokenHash_key" ON "CbotInstance"("tokenHash");
CREATE UNIQUE INDEX "CbotInstance_broker_accountNumber_environment_key" ON "CbotInstance"("broker", "accountNumber", "environment");
CREATE INDEX "CbotInstance_userId_status_idx" ON "CbotInstance"("userId", "status");
CREATE INDEX "SubscriptionAuditLog_userId_createdAt_idx" ON "SubscriptionAuditLog"("userId", "createdAt");
CREATE INDEX "SubscriptionAuditLog_subscriptionId_createdAt_idx" ON "SubscriptionAuditLog"("subscriptionId", "createdAt");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SubscriptionEntitlement" ADD CONSTRAINT "SubscriptionEntitlement_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CbotPairingCode" ADD CONSTRAINT "CbotPairingCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CbotInstance" ADD CONSTRAINT "CbotInstance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubscriptionAuditLog" ADD CONSTRAINT "SubscriptionAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
