-- CreateEnum
CREATE TYPE "CTraderConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'TOKEN_EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "CTraderAccountEnvironment" AS ENUM ('DEMO', 'LIVE');

-- CreateTable
CREATE TABLE "CTraderOAuthState" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stateHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CTraderOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CTraderConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "status" "CTraderConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CTraderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CTraderAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "ctidTraderAccountId" BIGINT NOT NULL,
    "traderLogin" BIGINT,
    "brokerTitle" TEXT,
    "environment" "CTraderAccountEnvironment" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CTraderAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CTraderOAuthState_stateHash_key" ON "CTraderOAuthState"("stateHash");
CREATE INDEX "CTraderOAuthState_userId_expiresAt_idx" ON "CTraderOAuthState"("userId", "expiresAt");
CREATE INDEX "CTraderConnection_userId_status_idx" ON "CTraderConnection"("userId", "status");
CREATE UNIQUE INDEX "CTraderAccount_userId_ctidTraderAccountId_environment_key" ON "CTraderAccount"("userId", "ctidTraderAccountId", "environment");
CREATE INDEX "CTraderAccount_userId_enabled_idx" ON "CTraderAccount"("userId", "enabled");
CREATE INDEX "CTraderAccount_connectionId_idx" ON "CTraderAccount"("connectionId");

ALTER TABLE "CTraderOAuthState" ADD CONSTRAINT "CTraderOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CTraderConnection" ADD CONSTRAINT "CTraderConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CTraderAccount" ADD CONSTRAINT "CTraderAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CTraderAccount" ADD CONSTRAINT "CTraderAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CTraderConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
