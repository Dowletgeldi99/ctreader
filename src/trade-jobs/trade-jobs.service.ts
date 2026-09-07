import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SafetyService } from "../safety/safety.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import type {
  Agent,
  ExecutionPhase,
  Prisma,
  TradeJobStatus,
} from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateTradeJobDto,
  ExecutionModeDto,
  ExecutionVenueDto,
  RiskModeDto,
} from "./dto/create-trade-job.dto";
import { SubmitExecutionReportDto } from "./dto/submit-execution-report.dto";
import { canTransition, statusForPhase } from "./trade-job-state";

const ACTIVE_JOB_STATUSES: TradeJobStatus[] = [
  "SCHEDULED",
  "SYNCED",
  "ARMED",
  "SUBMITTED",
  "PARTIALLY_FILLED",
  "FILLED",
  "MANAGED",
];

@Injectable()
export class TradeJobsService {
  private readonly allowRealTrading: boolean;
  private readonly maxRiskPercent: number;
  private readonly maxFixedLot: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly safety: SafetyService,
    private readonly subscriptions: SubscriptionsService,
  ) {
    this.allowRealTrading = config.getOrThrow<boolean>("ALLOW_REAL_TRADING");
    this.maxRiskPercent = config.getOrThrow<number>("MAX_RISK_PERCENT");
    this.maxFixedLot = config.getOrThrow<number>("MAX_FIXED_LOT");
  }

  async createForTelegramUser(telegramIdInput: string, dto: CreateTradeJobDto) {
    await this.safety.assertTradingOpen();
    if (!/^\d{1,20}$/.test(telegramIdInput)) {
      throw new BadRequestException("Invalid Telegram user id");
    }

    const user = await this.prisma.user.findUnique({
      where: { telegramId: BigInt(telegramIdInput) },
      include: { settings: true },
    });
    if (!user || !user.settings) throw new NotFoundException("Telegram user not found");
    if (user.status !== "ACTIVE") throw new ForbiddenException("User is suspended");

    const isCTrader = dto.executionVenue === ExecutionVenueDto.CTRADER;
    const mt5Account = isCTrader
      ? null
      : await this.prisma.tradingAccount.findUnique({ where: { id: dto.accountId } });
    const cTraderAccount = isCTrader
      ? await this.prisma.cTraderAccount.findUnique({ where: { id: dto.accountId } })
      : null;
    const selectedAccount = mt5Account ?? cTraderAccount;
    if (!selectedAccount || selectedAccount.userId !== user.id) {
      throw new NotFoundException("Trading account not found");
    }
    if (mt5Account && (!mt5Account.tradeAllowed || !mt5Account.expertTradeAllowed)) {
      throw new BadRequestException("Trading or Expert Advisor trading is disabled in MT5");
    }
    const isReal = mt5Account?.environment === "REAL" || cTraderAccount?.environment === "LIVE";
    await this.subscriptions.ensureTrial(user.id);
    await this.subscriptions.assertCanCreateJob(user.id, dto.executionMode, isReal,
      dto.riskMode === RiskModeDto.FIXED_LOT ? dto.fixedLot : null);
    if (isReal && (!this.allowRealTrading || !user.settings.realTradingEnabled)) {
      throw new ForbiddenException("Real trading is disabled by a safety policy");
    }
    if ([ExecutionModeDto.STRADDLE, ExecutionModeDto.MULTI, ExecutionModeDto.NEWS_REVERSAL].includes(dto.executionMode) && !dto.entryDistancePoints) {
      throw new BadRequestException("entryDistancePoints is required for pending modes");
    }
    if (dto.executionMode === ExecutionModeDto.MULTI) {
      if (!isCTrader && (!mt5Account || !["DEMO", "REAL"].includes(mt5Account.environment))) {
        throw new BadRequestException("MULTI requires an MT5 demo or real account");
      }
      if (!isCTrader && mt5Account?.marginMode !== "HEDGING") throw new BadRequestException("MULTI requires an MT5 hedging account");
      if (!dto.multiTradesPerSide || !dto.multiNextStepPoints || !dto.multiNextSlPoints || !dto.multiNextTpPoints) {
        throw new BadRequestException("All MULTI parameters are required");
      }
    }
    if (dto.executionMode === ExecutionModeDto.NEWS_REVERSAL) {
      if (!isCTrader) throw new BadRequestException("NEWS REVERSAL currently requires a cTrader account");
      if (dto.riskMode !== RiskModeDto.FIXED_LOT || !dto.fixedLot)
        throw new BadRequestException("NEWS REVERSAL currently requires fixed lot");
      if (!dto.volumeAllocationMode || !dto.takeProfit2Points || !dto.takeProfit3Points || !dto.reversalGapPoints)
        throw new BadRequestException("All NEWS REVERSAL parameters are required");
      if (!(dto.takeProfitPoints < dto.takeProfit2Points && dto.takeProfit2Points < dto.takeProfit3Points))
        throw new BadRequestException("NEWS REVERSAL take profits must be strictly increasing");
    }

    let executeAt = new Date(dto.executeAt);
    if (dto.economicEventId) {
      const event = await this.prisma.economicEvent.findUnique({
        where: { id: dto.economicEventId },
      });
      if (!event) throw new NotFoundException("Economic event not found");
      if (Math.abs(event.scheduledAt.getTime() - executeAt.getTime()) > 1_000) {
        throw new BadRequestException("Execution time must match the selected economic event");
      }
      executeAt = event.scheduledAt;
    }
    if (executeAt.getTime() < Date.now() + 20_000) {
      throw new BadRequestException("Execution time must be at least 20 seconds in the future");
    }

    this.validateRisk(dto);

    const activeCount = await this.prisma.tradeJob.count({
      where: { userId: user.id, status: { in: ACTIVE_JOB_STATUSES } },
    });
    if (activeCount >= user.settings.maxConcurrentJobs) {
      throw new ConflictException("Maximum number of concurrent news jobs reached");
    }

    const idempotencyKey = dto.idempotencyKey ?? `job_${randomUUID()}`;
    const existing = await this.prisma.tradeJob.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.userId !== user.id) throw new ConflictException("Idempotency key is already used");
      return existing;
    }

    const armSeconds = dto.armSeconds ?? user.settings.defaultArmSeconds;
    const maxLatenessMs = dto.maxLatenessMs ?? user.settings.defaultMaxLatenessMs;
    const deviationPoints = dto.deviationPoints ?? user.settings.defaultDeviationPoints;
    const maxSpreadPoints = dto.maxSpreadPoints ?? user.settings.defaultMaxSpreadPoints;
    const entryDistancePoints = dto.entryDistancePoints ?? 100;
    const pendingExpirySeconds = dto.pendingExpirySeconds ?? 30;
    const expiresAt = new Date(
      executeAt.getTime() +
        ([ExecutionModeDto.STRADDLE, ExecutionModeDto.MULTI, ExecutionModeDto.NEWS_REVERSAL].includes(dto.executionMode)
          ? pendingExpirySeconds * 1_000
          : Math.max(maxLatenessMs, 1_000)),
    );
    const settingsSnapshot: Prisma.InputJsonObject = {
      protocolVersion: dto.executionMode === ExecutionModeDto.NEWS_REVERSAL ? 4 : dto.executionMode === ExecutionModeDto.MULTI ? 3 : 2,
      realTradingSystemEnabled: this.allowRealTrading,
      realTradingUserEnabled: user.settings.realTradingEnabled,
      maxRiskPercent: this.maxRiskPercent,
      maxFixedLot: this.maxFixedLot,
      executionVenue: isCTrader ? "CTRADER" : "MT5",
      accountEnvironment: selectedAccount.environment,
      accountServer: mt5Account?.server ?? cTraderAccount?.brokerTitle ?? "cTrader",
      createdFrom: "telegram",
    };
    const mockMidPrice = dto.symbol.toUpperCase().includes("XAU") ? 2_500 : 1.1;
    const mockPoint = dto.symbol.toUpperCase().includes("XAU") ? 0.01 : 0.0001;

    return this.prisma.$transaction(async (tx) => {
      const job = await tx.tradeJob.create({
        data: {
          userId: user.id,
          accountId: mt5Account?.id,
          cTraderAccountId: cTraderAccount?.id,
          executionVenue: isCTrader ? "CTRADER" : "MT5",
          economicEventId: dto.economicEventId,
          idempotencyKey,
          symbol: dto.symbol,
          direction: dto.direction,
          executionMode: dto.executionMode,
          riskMode: dto.riskMode,
          fixedLot: dto.fixedLot,
          riskPercent: dto.riskPercent,
          stopLossPoints: dto.stopLossPoints,
          takeProfitPoints: dto.takeProfitPoints,
          deviationPoints,
          maxSpreadPoints,
          armSeconds,
          maxLatenessMs,
          entryDistancePoints,
          pendingExpirySeconds,
          multiTradesPerSide: dto.multiTradesPerSide,
          multiNextStepPoints: dto.multiNextStepPoints,
          multiNextSlPoints: dto.multiNextSlPoints,
          multiNextTpPoints: dto.multiNextTpPoints,
          volumeAllocationMode: dto.volumeAllocationMode,
          takeProfit2Points: dto.takeProfit2Points,
          takeProfit3Points: dto.takeProfit3Points,
          reversalTp1BufferPoints: dto.reversalTp1BufferPoints,
          reversalTp2BufferPoints: dto.reversalTp2BufferPoints,
          reversalGapPoints: dto.reversalGapPoints,
          maxReversals: dto.executionMode === ExecutionModeDto.NEWS_REVERSAL ? 1 : undefined,
          newsReversalState: dto.executionMode === ExecutionModeDto.NEWS_REVERSAL ? "WAITING_INITIAL_FILL" : undefined,
          managementExpiresAt: dto.executionMode === ExecutionModeDto.NEWS_REVERSAL
            ? new Date(executeAt.getTime() + (dto.managementSeconds ?? 300) * 1_000)
            : undefined,
          mockOutcome: isCTrader ? "BUY_FILL" : undefined,
          mockBid: isCTrader ? mockMidPrice - mockPoint : undefined,
          mockAsk: isCTrader ? mockMidPrice + mockPoint : undefined,
          executeAt,
          expiresAt,
          status: "SCHEDULED",
          settingsSnapshot,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          actorType: "ADMIN_API",
          actorId: telegramIdInput,
          action: "TRADE_JOB_CREATED",
          entityType: "TradeJob",
          entityId: job.id,
          metadata: { idempotencyKey, symbol: dto.symbol, direction: dto.direction },
        },
      });
      return job;
    });
  }

  async pollForAgent(agent: Agent, horizonInput?: string) {
    const horizonMinutes = this.parseHorizon(horizonInput);
    const now = new Date();
    const horizon = new Date(now.getTime() + horizonMinutes * 60_000);

    const jobs = await this.prisma.tradeJob.findMany({
      where: {
        account: { agentId: agent.id },
        executionVenue: "MT5",
        // Active jobs are also returned so an EA restart can recover and manage
        // already placed OCO orders from its local idempotency ledger.
        status: { in: ["SCHEDULED", "SYNCED", "ARMED", "SUBMITTED", "FILLED"] },
        executeAt: { lte: horizon },
        expiresAt: { gt: now },
      },
      include: { account: true, user: { include: { settings: true } } },
      orderBy: { executeAt: "asc" },
      take: 100,
    });
    const cancellations = await this.prisma.tradeJob.findMany({
      where: {
        account: { agentId: agent.id },
        executionVenue: "MT5",
        status: "CANCELLED",
        updatedAt: { gte: new Date(now.getTime() - 24 * 60 * 60_000) },
      },
      select: { id: true, version: true, cancelledAt: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    const executable = jobs.filter((job) => {
      if (job.account?.environment !== "REAL") return true;
      return this.allowRealTrading && job.user.settings?.realTradingEnabled === true;
    });
    const newlySyncedIds = executable
      .filter((job) => job.status === "SCHEDULED")
      .map((job) => job.id);

    if (newlySyncedIds.length > 0) {
      await this.prisma.tradeJob.updateMany({
        where: { id: { in: newlySyncedIds }, status: "SCHEDULED" },
        data: { status: "SYNCED", syncedAt: now },
      });
    }

    return {
      protocolVersion: 2,
      serverTime: now.toISOString(),
      cancellations,
      jobs: executable.map((job) => ({
        id: job.id,
        idempotencyKey: job.idempotencyKey,
        accountId: job.accountId,
        accountLogin: job.account!.login.toString(),
        accountServer: job.account!.server,
        accountEnvironment: job.account!.environment,
        symbol: job.symbol,
        direction: job.direction,
        executionMode: job.executionMode,
        riskMode: job.riskMode,
        fixedLot: job.fixedLot?.toString(),
        riskPercent: job.riskPercent?.toString(),
        stopLossPoints: job.stopLossPoints,
        takeProfitPoints: job.takeProfitPoints,
        deviationPoints: job.deviationPoints,
        maxSpreadPoints: job.maxSpreadPoints,
        armSeconds: job.armSeconds,
        maxLatenessMs: job.maxLatenessMs,
        entryDistancePoints: job.entryDistancePoints,
        pendingExpirySeconds: job.pendingExpirySeconds,
        multiTradesPerSide: job.multiTradesPerSide,
        multiNextStepPoints: job.multiNextStepPoints,
        multiNextSlPoints: job.multiNextSlPoints,
        multiNextTpPoints: job.multiNextTpPoints,
        executeAt: job.executeAt.toISOString(),
        expiresAt: job.expiresAt.toISOString(),
        version: job.version,
      })),
    };
  }

  async pollForAgentText(agent: Agent, horizonInput?: string): Promise<string> {
    const response = await this.pollForAgent(agent, horizonInput);
    const lines = [`NEWSBOT/2|${response.serverTime}`];
    for (const job of response.jobs) {
      if (job.executionMode === "MULTI") {
        lines.push([
          "JOB3", job.id, job.idempotencyKey, job.accountLogin,
          this.sanitizeWireValue(job.accountServer), job.accountEnvironment, job.symbol,
          job.riskMode, job.fixedLot ?? "", job.riskPercent ?? "",
          job.stopLossPoints, job.takeProfitPoints, job.deviationPoints,
          job.maxSpreadPoints, job.armSeconds, job.entryDistancePoints,
          job.pendingExpirySeconds, job.multiTradesPerSide ?? 2,
          job.multiNextStepPoints ?? job.entryDistancePoints,
          job.multiNextSlPoints ?? job.stopLossPoints,
          job.multiNextTpPoints ?? job.takeProfitPoints,
          Math.floor(new Date(job.executeAt).getTime() / 1_000) + agent.serverUtcOffsetSeconds,
          Math.floor(new Date(job.expiresAt).getTime() / 1_000) + agent.serverUtcOffsetSeconds,
          job.version,
        ].join("|"));
        continue;
      }
      lines.push(
        [
          "JOB2",
          job.id,
          job.idempotencyKey,
          job.accountLogin,
          this.sanitizeWireValue(job.accountServer),
          job.accountEnvironment,
          job.symbol,
          job.direction,
          job.executionMode,
          job.riskMode,
          job.fixedLot ?? "",
          job.riskPercent ?? "",
          job.stopLossPoints,
          job.takeProfitPoints,
          job.deviationPoints,
          job.maxSpreadPoints,
          job.armSeconds,
          job.maxLatenessMs,
          job.entryDistancePoints,
          job.pendingExpirySeconds,
          Math.floor(new Date(job.executeAt).getTime() / 1_000) + agent.serverUtcOffsetSeconds,
          Math.floor(new Date(job.expiresAt).getTime() / 1_000) + agent.serverUtcOffsetSeconds,
          job.version,
        ].join("|"),
      );
    }
    for (const cancellation of response.cancellations) {
      lines.push(
        [
          "CANCEL",
          cancellation.id,
          cancellation.version,
          cancellation.cancelledAt?.toISOString() ?? response.serverTime,
        ].join("|"),
      );
    }
    return `${lines.join("\n")}\n`;
  }

  async listActiveForTelegramUser(telegramId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.prisma.tradeJob.findMany({
      where: { userId: user.id, status: { in: ACTIVE_JOB_STATUSES } },
      include: { economicEvent: true, account: true, cTraderAccount: true },
      orderBy: { executeAt: "asc" },
      take: 20,
    });
  }

  async listRecentFinalForTelegramUser(telegramId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.prisma.tradeJob.findMany({
      where: { userId: user.id, status: { in: ["REJECTED", "CANCELLED", "EXPIRED", "MISSED", "CLOSED"] } },
      include: { executionReports: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
      take: 3,
    });
  }

  async listRecentCTraderForTelegramUser(telegramId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.prisma.tradeJob.findMany({
      where: { userId: user.id, executionVenue: "CTRADER" },
      include: {
        cTraderAccount: true,
        executionReports: { orderBy: { occurredAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
  }

  async cancelForTelegramUser(telegramId: bigint, jobId: string) {
    const job = await this.prisma.tradeJob.findFirst({
      where: { id: jobId, user: { telegramId } },
    });
    if (!job) throw new NotFoundException("Trade job not found");
    if (!["SCHEDULED", "SYNCED"].includes(job.status)) {
      if (job.executionVenue !== "CTRADER" || !ACTIVE_JOB_STATUSES.includes(job.status))
        throw new ConflictException(`Job cannot be cancelled from state ${job.status}`);
      return this.prisma.tradeJob.update({ where: { id: job.id }, data: { cancelRequestedAt: new Date() } });
    }
    const cancellationCutoff = job.executeAt.getTime() - job.armSeconds * 1_000;
    if (Date.now() >= cancellationCutoff) {
      throw new ConflictException("Job is already inside its armed execution window");
    }

    const now = new Date();
    const cancelled = await this.prisma.tradeJob.update({
      where: { id: job.id },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        version: { increment: 1 },
      },
    });
    await this.prisma.auditLog.create({
      data: {
        userId: job.userId,
        actorType: "TELEGRAM_USER",
        actorId: telegramId.toString(),
        action: "TRADE_JOB_CANCELLED",
        entityType: "TradeJob",
        entityId: job.id,
      },
    });
    return cancelled;
  }

  async requestCloseForTelegramUser(telegramId: bigint, jobId: string) {
    const job = await this.prisma.tradeJob.findFirst({ where: { id: jobId, user: { telegramId } } });
    if (!job) throw new NotFoundException("Trade job not found");
    if (job.executionVenue !== "CTRADER" || !ACTIVE_JOB_STATUSES.includes(job.status))
      throw new ConflictException(`Job cannot be closed from state ${job.status}`);
    return this.prisma.tradeJob.update({ where: { id: job.id }, data: { closeRequestedAt: new Date() } });
  }

  async requestCloseAllForTelegramUser(telegramId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.prisma.tradeJob.updateMany({ where: { userId: user.id, executionVenue: "CTRADER",
      status: { in: ACTIVE_JOB_STATUSES } }, data: { closeRequestedAt: new Date() } });
  }

  async submitReport(agent: Agent, jobId: string, dto: SubmitExecutionReportDto) {
    const job = await this.prisma.tradeJob.findUnique({
      where: { id: jobId },
      include: { account: true },
    });
    if (!job || job.executionVenue !== "MT5" || job.account?.agentId !== agent.id) {
      throw new NotFoundException("Trade job not found");
    }

    const existing = await this.prisma.executionReport.findUnique({
      where: { reportKey: dto.reportKey },
    });
    if (existing) {
      if (existing.jobId !== jobId || existing.agentId !== agent.id) {
        throw new ConflictException("Report key is already used");
      }
      return { accepted: true, duplicate: true, reportId: existing.id };
    }

    const phase = dto.phase as ExecutionPhase;
    const nextStatus = statusForPhase(phase);
    if (nextStatus && !canTransition(job.status, nextStatus)) {
      throw new ConflictException(`Invalid job transition: ${job.status} -> ${nextStatus}`);
    }

    const occurredAt = new Date(dto.occurredAt);
    const jobUpdate = this.timestampsForPhase(nextStatus, occurredAt);

    return this.prisma.$transaction(async (tx) => {
      const report = await tx.executionReport.create({
        data: {
          jobId,
          agentId: agent.id,
          reportKey: dto.reportKey,
          phase,
          occurredAt,
          orderTicket: dto.orderTicket,
          dealTicket: dto.dealTicket,
          retcode: dto.retcode,
          message: dto.message,
          requestedPrice: dto.requestedPrice,
          filledPrice: dto.filledPrice,
          filledVolume: dto.filledVolume,
          spreadPoints: dto.spreadPoints,
          latencyMs: dto.latencyMs,
          raw: dto.raw as Prisma.InputJsonObject | undefined,
        },
      });

      if (nextStatus) {
        await tx.tradeJob.update({
          where: { id: jobId },
          data: { status: nextStatus, ...jobUpdate },
        });
      }

      await tx.auditLog.create({
        data: {
          userId: job.userId,
          actorType: "MT5_AGENT",
          actorId: agent.id,
          action: `EXECUTION_${phase}`,
          entityType: "TradeJob",
          entityId: jobId,
          metadata: { reportKey: dto.reportKey, retcode: dto.retcode ?? null },
        },
      });

      return { accepted: true, duplicate: false, reportId: report.id, jobStatus: nextStatus ?? job.status };
    });
  }

  private validateRisk(dto: CreateTradeJobDto): void {
    if (dto.riskMode === RiskModeDto.FIXED_LOT) {
      if (dto.fixedLot === undefined) throw new BadRequestException("fixedLot is required");
      if (dto.fixedLot > this.maxFixedLot) {
        throw new BadRequestException(`fixedLot exceeds system limit ${this.maxFixedLot}`);
      }
      if (dto.riskPercent !== undefined) {
        throw new BadRequestException("riskPercent is not allowed for FIXED_LOT mode");
      }
    } else {
      if (dto.riskPercent === undefined) throw new BadRequestException("riskPercent is required");
      if (dto.riskPercent > this.maxRiskPercent) {
        throw new BadRequestException(`riskPercent exceeds system limit ${this.maxRiskPercent}`);
      }
      if (dto.fixedLot !== undefined) {
        throw new BadRequestException("fixedLot is not allowed for RISK_PERCENT mode");
      }
    }
  }

  private parseHorizon(input?: string): number {
    if (!input) return 1_440;
    const parsed = Number(input);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_440) {
      throw new BadRequestException("horizonMinutes must be an integer between 1 and 1440");
    }
    return parsed;
  }

  private timestampsForPhase(status: TradeJobStatus | undefined, occurredAt: Date) {
    switch (status) {
      case "SYNCED":
        return { syncedAt: occurredAt };
      case "ARMED":
        return { armedAt: occurredAt };
      case "SUBMITTED":
        return { submittedAt: occurredAt };
      case "FILLED":
      case "PARTIALLY_FILLED":
        return { filledAt: occurredAt };
      case "CLOSED":
        return { closedAt: occurredAt };
      case "CANCELLED":
        return { cancelledAt: occurredAt };
      default:
        return {};
    }
  }

  private sanitizeWireValue(value: string): string {
    return value.replace(/[|\r\n]/g, "_");
  }
}
