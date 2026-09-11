import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createAgentToken, createPairingCode, hashSecret } from "../common/crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ClaimCbotPairingDto } from "./dto/claim-cbot-pairing.dto";
import { SubmitExecutionReportDto } from "../trade-jobs/dto/submit-execution-report.dto";
import { canTransition, statusForPhase } from "../trade-jobs/trade-job-state";
import type { ExecutionPhase, Prisma, TradeJobStatus } from "../generated/prisma/client";
import { CbotHeartbeatDto } from "./dto/cbot-heartbeat.dto";
import { CbotCandleBatchDto } from "./dto/cbot-candle-batch.dto";
import { ProbeStrategyService } from "../strategy-v2/probe-strategy.service";

@Injectable()
export class CbotService {
  private readonly pepper: string;
  private readonly ttlSeconds: number;
  private readonly telegramBotToken?: string;

  constructor(private readonly prisma: PrismaService, config: ConfigService,
    private readonly subscriptions: SubscriptionsService, private readonly probeStrategy: ProbeStrategyService) {
    this.pepper = config.getOrThrow<string>("AGENT_TOKEN_PEPPER");
    this.ttlSeconds = config.getOrThrow<number>("PAIRING_CODE_TTL_SECONDS");
    this.telegramBotToken = config.get<string>("TELEGRAM_BOT_TOKEN");
  }

  async ingestStrategyCandles(instanceId: string, dto: CbotCandleBatchDto) {
    const instance = await this.prisma.cbotInstance.findUnique({ where: { id: instanceId } });
    if (!instance) throw new NotFoundException("cBot instance not found");
    if (instance.environment !== "DEMO") throw new BadRequestException("Strategy V2 is demo-only");
    const source = `CBOT:${instance.id}`;
    const candles = [...dto.candles].sort((a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime());
    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];
      if (candle.symbol.toUpperCase() !== instance.symbol.toUpperCase())
        throw new BadRequestException("Candle symbol does not match cBot instance");
      await this.probeStrategy.ingest({ ...candle, openTime: new Date(candle.openTime), source }, instance.id,
        candle.timeframe === "M15" && index === candles.length - 1);
    }
    return { accepted: candles.length };
  }

  async createPairingCode(userId: string) {
    const code = createPairingCode();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1_000);
    await this.prisma.cbotPairingCode.create({ data: { userId, codeHash: hashSecret(code, this.pepper), expiresAt } });
    return { code, expiresAt };
  }

  async authenticateToken(token: string) {
    if (!token || token.length > 256) throw new BadRequestException("Invalid cBot token");
    const tokenHash = hashSecret(token, this.pepper);
    const instance = await this.prisma.cbotInstance.findUnique({ where: { tokenHash } });
    if (!instance || instance.status === "REVOKED") throw new BadRequestException("Invalid or revoked cBot token");
    return instance;
  }

  async claim(dto: ClaimCbotPairingDto, ip?: string) {
    const pairing = await this.prisma.cbotPairingCode.findUnique({
      where: { codeHash: hashSecret(dto.code.toUpperCase(), this.pepper) },
    });
    if (!pairing) throw new NotFoundException("cBot pairing code not found");
    if (pairing.claimedAt) throw new ConflictException("cBot pairing code already used");
    if (pairing.expiresAt <= new Date()) throw new BadRequestException("cBot pairing code expired");
    const accountNumber = BigInt(dto.accountNumber);
    const existingAccount = await this.prisma.cbotInstance.findUnique({
      where: { broker_accountNumber_environment: { broker: dto.broker, accountNumber, environment: dto.environment } },
    });
    if (existingAccount && existingAccount.userId !== pairing.userId)
      throw new ConflictException("This cTrader account is already paired with another user");
    if (!existingAccount || existingAccount.status === "REVOKED")
      await this.subscriptions.assertCanPairAccount(pairing.userId, dto.environment);

    const token = createAgentToken();
    const tokenHash = hashSecret(token, this.pepper);
    const now = new Date();
    const instance = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.cbotPairingCode.updateMany({
        where: { id: pairing.id, claimedAt: null, expiresAt: { gt: now } }, data: { claimedAt: now },
      });
      if (claimed.count !== 1) throw new ConflictException("cBot pairing code cannot be claimed");
      return tx.cbotInstance.upsert({
        where: { broker_accountNumber_environment: { broker: dto.broker, accountNumber, environment: dto.environment } },
        create: { userId: pairing.userId, instanceKey: dto.instanceKey, tokenHash, accountNumber,
          broker: dto.broker, environment: dto.environment, symbol: dto.symbol ?? "XAUUSD", version: dto.version,
          status: "ONLINE", lastIp: ip, lastSeenAt: now },
        update: { instanceKey: dto.instanceKey, tokenHash, symbol: dto.symbol ?? "XAUUSD", version: dto.version,
          status: "ONLINE", lastIp: ip, lastSeenAt: now },
      });
    });
    return { protocolVersion: 1, instanceId: instance.id, token,
      message: "Store this token in cBot local storage. It will not be shown again." };
  }

  async heartbeat(instanceId: string, dto: CbotHeartbeatDto, ip?: string) {
    const instance = await this.prisma.cbotInstance.findUnique({ where: { id: instanceId } });
    if (!instance) throw new NotFoundException("cBot instance not found");
    if (instance.accountNumber !== BigInt(dto.accountNumber) || instance.broker !== dto.broker || instance.environment !== dto.environment)
      throw new ConflictException("Active cTrader account does not match the paired cBot account");
    return this.prisma.cbotInstance.update({ where: { id: instanceId },
      data: { status: "ONLINE", lastSeenAt: new Date(), lastIp: ip, symbol: dto.symbol, version: dto.version },
      select: { id: true, status: true, lastSeenAt: true } });
  }

  async entitlement(userId: string) {
    const subscription = await this.subscriptions.currentForUser(userId);
    const control = await this.prisma.systemControl.upsert({
      where: { id: "global" }, create: { id: "global" }, update: {},
    });
    const subscriptionAllowsTrading = !this.subscriptions.isEnforced()
      || Boolean(subscription?.entitlement && ["TRIAL", "ACTIVE"].includes(subscription.status));
    return {
      enforcementEnabled: this.subscriptions.isEnforced(),
      status: subscription?.status ?? "NONE",
      plan: subscription?.plan.code ?? null,
      validUntil: subscription?.currentPeriodEnd ?? null,
      permissions: subscription?.entitlement ?? null,
      acceptNewJobs: subscriptionAllowsTrading && !control.tradingHalted,
      manageExistingPositions: true,
      tradingHalted: control.tradingHalted,
      haltReason: control.reason,
    };
  }

  async poll(instanceId: string, userId: string, horizonMinutes = 1440) {
    if (!Number.isInteger(horizonMinutes) || horizonMinutes < 1 || horizonMinutes > 1440)
      throw new BadRequestException("horizonMinutes must be between 1 and 1440");
    const access = await this.entitlement(userId);
    const now = new Date();
    const abandonedBefore = new Date(now.getTime() - 60_000);
    // A Cloud cBot can disconnect or reject a payload before reporting anything.
    // Expire delivery-stage jobs server-side so they cannot remain SYNCED forever
    // and block the user's next job.
    await this.prisma.tradeJob.updateMany({
      where: {
        cbotInstanceId: instanceId,
        executionVenue: "CBOT",
        status: { in: ["SCHEDULED", "SYNCED", "ARMED"] },
        expiresAt: { lte: abandonedBefore },
      },
      data: { status: "MISSED" },
    });
    const statuses: TradeJobStatus[] = access.acceptNewJobs
      ? ["SCHEDULED", "SYNCED", "ARMED", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "MANAGED"]
      : ["ARMED", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "MANAGED"];
    const jobs = await this.prisma.tradeJob.findMany({
      where: { cbotInstanceId: instanceId, executionVenue: "CBOT", status: { in: statuses },
        executeAt: { lte: new Date(now.getTime() + horizonMinutes * 60_000) },
        OR: [{ managementExpiresAt: { gt: now } }, { expiresAt: { gt: now } },
          { status: { in: ["SUBMITTED", "PARTIALLY_FILLED", "FILLED", "MANAGED"] } }] },
      orderBy: { executeAt: "asc" }, take: 50,
    });
    const fresh = jobs.filter((job) => job.status === "SCHEDULED").map((job) => job.id);
    if (fresh.length) await this.prisma.tradeJob.updateMany({ where: { id: { in: fresh }, status: "SCHEDULED" },
      data: { status: "SYNCED", syncedAt: now } });
    return { protocolVersion: 1, serverTime: now.toISOString(), acceptNewJobs: access.acceptNewJobs,
      tradingHalted: access.tradingHalted,
      jobs: jobs.map((job) => ({
        id: job.id, version: job.version, symbol: job.symbol, direction: job.direction,
        executionMode: job.executionMode, fixedLot: job.fixedLot?.toString(), stopLossPoints: job.stopLossPoints,
        takeProfitPoints: job.takeProfitPoints, entryDistancePoints: job.entryDistancePoints,
        deviationPoints: job.deviationPoints, maxSpreadPoints: job.maxSpreadPoints,
        armSeconds: job.armSeconds, maxLatenessMs: job.maxLatenessMs,
        pendingExpirySeconds: job.pendingExpirySeconds,
        multiTradesPerSide: job.multiTradesPerSide ?? undefined,
        multiNextStepPoints: job.multiNextStepPoints ?? undefined,
        multiNextSlPoints: job.multiNextSlPoints ?? undefined,
        multiNextTpPoints: job.multiNextTpPoints ?? undefined,
        volumeAllocationMode: job.volumeAllocationMode ?? undefined,
        takeProfit2Points: job.takeProfit2Points ?? undefined,
        takeProfit3Points: job.takeProfit3Points ?? undefined,
        reversalGapPoints: job.reversalGapPoints ?? undefined,
        maxReversals: job.maxReversals ?? undefined,
        executeAt: job.executeAt.toISOString(), expiresAt: job.expiresAt.toISOString(),
        managementExpiresAt: job.managementExpiresAt?.toISOString(),
        cancelRequested: Boolean(job.cancelRequestedAt), closeRequested: Boolean(job.closeRequestedAt),
      })) };
  }

  async report(instanceId: string, jobId: string, dto: SubmitExecutionReportDto) {
    const job = await this.prisma.tradeJob.findFirst({
      where: { id: jobId, cbotInstanceId: instanceId, executionVenue: "CBOT" },
      include: { user: { select: { telegramId: true } } },
    });
    if (!job) throw new NotFoundException("cBot trade job not found");
    const existing = await this.prisma.executionReport.findUnique({ where: { reportKey: dto.reportKey } });
    if (existing) {
      if (existing.jobId !== jobId || existing.executionSource !== `CBOT:${instanceId}`)
        throw new ConflictException("Report key is already used");
      return { accepted: true, duplicate: true, reportId: existing.id };
    }
    const phase = dto.phase as ExecutionPhase;
    const requestedStatus = statusForPhase(phase);
    // Execution callbacks can arrive milliseconds out of order (especially MARKET fills).
    // Persist every report, but never downgrade an already more advanced job state.
    const nextStatus = requestedStatus && canTransition(job.status, requestedStatus) ? requestedStatus : undefined;
    const occurredAt = new Date(dto.occurredAt);
    const result = await this.prisma.$transaction(async (tx) => {
      const report = await tx.executionReport.create({ data: {
        jobId, executionSource: `CBOT:${instanceId}`, reportKey: dto.reportKey, phase, occurredAt,
        orderTicket: dto.orderTicket, dealTicket: dto.dealTicket, retcode: dto.retcode,
        message: dto.message, requestedPrice: dto.requestedPrice, filledPrice: dto.filledPrice,
        filledVolume: dto.filledVolume, spreadPoints: dto.spreadPoints, latencyMs: dto.latencyMs,
        raw: dto.raw as Prisma.InputJsonObject | undefined,
      } });
      if (nextStatus) await tx.tradeJob.update({ where: { id: jobId },
        data: { status: nextStatus, ...this.timestampsForPhase(nextStatus, occurredAt) } });
      await tx.auditLog.create({ data: { userId: job.userId, actorType: "CBOT", actorId: instanceId,
        action: `EXECUTION_${phase}`, entityType: "TradeJob", entityId: jobId,
        metadata: { reportKey: dto.reportKey } } });
      return { accepted: true, duplicate: false, reportId: report.id, jobStatus: nextStatus ?? job.status };
    });
    if (["PREFLIGHT_REJECTED", "REJECTED"].includes(dto.phase)) {
      const snapshot = job.settingsSnapshot as Prisma.JsonObject;
      const positionId = typeof snapshot.strategyPositionId === "string" ? snapshot.strategyPositionId : undefined;
      const leg = snapshot.leg;
      if (snapshot.strategy === "PROBE_ENTRY_V2" && leg === "PROBE" && positionId) {
        await this.prisma.strategyPosition.updateMany({
          where: { id: positionId, state: "PROBE_OPEN" },
          data: { state: "CLOSED_TIMEOUT", closedAt: occurredAt, closeReason: `cBot rejected probe: ${dto.message ?? dto.phase}` },
        });
      }
    }
    if (["PREFLIGHT_REJECTED", "REJECTED", "ERROR"].includes(dto.phase) ||
        (dto.phase === "ARMED" && dto.message?.includes("WARNING"))) {
      void this.notifyTelegram(job.user.telegramId, job.symbol, job.executionMode, dto.phase, dto.message)
        .catch(() => undefined);
    }
    return result;
  }

  private async notifyTelegram(telegramId: bigint, symbol: string, mode: string, phase: string, message?: string) {
    if (!this.telegramBotToken) return;
    await fetch(`https://api.telegram.org/bot${this.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: telegramId.toString(), text: `⚠️ ${symbol} ${mode}\n${phase}\n${message ?? "No details"}` }),
      signal: AbortSignal.timeout(5_000),
    });
  }

  private timestampsForPhase(status: TradeJobStatus, occurredAt: Date) {
    if (status === "SYNCED") return { syncedAt: occurredAt };
    if (status === "ARMED") return { armedAt: occurredAt };
    if (status === "SUBMITTED") return { submittedAt: occurredAt };
    if (["FILLED", "PARTIALLY_FILLED"].includes(status)) return { filledAt: occurredAt };
    if (status === "CLOSED") return { closedAt: occurredAt };
    if (status === "CANCELLED") return { cancelledAt: occurredAt };
    return {};
  }
}
