import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class CTraderMockExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CTraderMockExecutionService.name);
  private timer?: NodeJS.Timeout;
  private readonly enabled: boolean;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.enabled = config.get<boolean>("CTRADER_MOCK_MODE") ?? false;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), 250);
    this.timer.unref();
    this.logger.log("cTrader mock execution loop started");
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async setOutcome(userId: string, jobId: string, outcome: "BUY_FILL" | "SELL_FILL" | "TIMEOUT" | "REJECT") {
    return this.prisma.tradeJob.updateMany({
      where: { id: jobId, userId, executionVenue: "CTRADER", status: "SCHEDULED" },
      data: { mockOutcome: outcome },
    });
  }

  private async tick(): Promise<void> {
    const now = new Date();
    try {
      const jobs = await this.prisma.tradeJob.findMany({
        where: {
          executionVenue: "CTRADER",
          status: { in: ["SCHEDULED", "ARMED", "FILLED", "MANAGED"] },
          executeAt: { lte: new Date(now.getTime() + 60_000) },
        },
        take: 100,
      });
      for (const job of jobs) {
        if (job.status === "SCHEDULED" && now.getTime() >= job.executeAt.getTime() - job.armSeconds * 1_000) {
          await this.arm(job.id, now);
          continue;
        }
        if (job.status === "ARMED" && now >= job.executeAt) {
          await this.execute(job.id, now);
          continue;
        }
        if (job.executionMode === "NEWS_REVERSAL" && ["FILLED", "MANAGED"].includes(job.status) &&
            now.getTime() >= job.updatedAt.getTime() + 1_000) {
          await this.advanceNewsReversal(job.id, now);
          continue;
        }
        if (job.status === "FILLED" && job.filledAt && now.getTime() >= job.filledAt.getTime() + 2_000) {
          await this.close(job.id, now);
        }
      }
    } catch (error) {
      this.logger.error("cTrader mock tick failed", error);
    }
  }

  private async arm(jobId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tradeJob.updateMany({
        where: { id: jobId, status: "SCHEDULED" },
        data: { status: "ARMED", armedAt: now },
      });
      if (claimed.count !== 1) return;
      await tx.executionReport.create({
        data: {
          jobId,
          reportKey: `mock:${jobId}:armed`,
          executionSource: "CTRADER_MOCK",
          phase: "ARMED",
          occurredAt: now,
          message: "Mock preflight passed; pending orders armed",
        },
      });
    });
  }

  private async execute(jobId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.tradeJob.findUnique({ where: { id: jobId } });
      if (!job || job.status !== "ARMED") return;
      const outcome = job.mockOutcome ?? "BUY_FILL";
      if (outcome === "TIMEOUT" && now < job.expiresAt) return;

      if (outcome === "REJECT") {
        await tx.tradeJob.update({ where: { id: jobId }, data: { status: "REJECTED", submittedAt: now } });
        await tx.executionReport.create({
          data: {
            jobId,
            reportKey: `mock:${jobId}:rejected`,
            executionSource: "CTRADER_MOCK",
            phase: "REJECTED",
            occurredAt: now,
            message: "Mock broker rejected both pending orders",
            retcode: 1,
          },
        });
        return;
      }
      if (outcome === "TIMEOUT") {
        await tx.tradeJob.update({ where: { id: jobId }, data: { status: "EXPIRED", cancelledAt: now } });
        await tx.executionReport.create({
          data: {
            jobId,
            reportKey: `mock:${jobId}:expired`,
            executionSource: "CTRADER_MOCK",
            phase: "CANCELLED",
            occurredAt: now,
            message: "Mock OCO expired; both pending orders cancelled",
          },
        });
        return;
      }

      const direction = job.executionMode === "MARKET" ? job.direction : outcome === "SELL_FILL" ? "SELL" : "BUY";
      const bid = Number(job.mockBid ?? 1.1);
      const ask = Number(job.mockAsk ?? 1.1002);
      const point = Math.max(Math.abs(ask - bid) / 2, 0.00001);
      const requested = direction === "BUY" ? ask : bid;
      const slippage = job.mockSlippagePoints * point * (direction === "BUY" ? 1 : -1);
      const filled = requested + slippage;
      const volume = Number(job.fixedLot ?? 0.01);
      if (job.executionMode === "NEWS_REVERSAL") {
        const volumes = job.volumeAllocationMode === "FULL_EACH"
          ? [volume, volume, volume]
          : [Number((volume * 0.33).toFixed(4)), Number((volume * 0.33).toFixed(4)), Number((volume * 0.34).toFixed(4))];
        for (const side of ["BUY", "SELL"] as const) for (let index = 0; index < 3; index += 1) {
          await tx.tradeJobLeg.upsert({ where: { jobId_purpose_direction_targetNumber_revision: {
            jobId, purpose: "INITIAL", direction: side, targetNumber: index + 1, revision: 0,
          } }, update: {}, create: { jobId, purpose: "INITIAL", direction: side, targetNumber: index + 1,
            revision: 0, legNumber: index + 1, plannedVolume: volumes[index],
            status: side === direction ? "FILLED" : "CANCELLED",
            brokerOrderId: `mock-${side}-${index + 1}-${jobId.slice(0, 8)}`,
            brokerPositionId: side === direction ? `mock-pos-${side}-${index + 1}-${jobId.slice(0, 8)}` : undefined,
            filledVolume: side === direction ? volumes[index] : undefined } });
        }
      }
      await tx.tradeJob.update({
        where: { id: jobId },
        data: { status: "FILLED", submittedAt: now, filledAt: now,
          activeDirection: job.executionMode === "NEWS_REVERSAL" ? direction : undefined,
          newsReversalState: job.executionMode === "NEWS_REVERSAL"
            ? direction === "BUY" ? "INITIAL_BUY_ACTIVE" : "INITIAL_SELL_ACTIVE"
            : undefined },
      });
      await tx.executionReport.createMany({
        data: [
          {
            jobId,
            reportKey: `mock:${jobId}:submitted`,
            executionSource: "CTRADER_MOCK",
            phase: "SUBMITTED",
            occurredAt: now,
            orderTicket: `mock-order-${jobId.slice(0, 8)}`,
            requestedPrice: new Prisma.Decimal(requested),
            message: job.executionMode === "STRADDLE" ? "Mock Buy Stop and Sell Stop accepted" : "Mock market order accepted",
          },
          {
            jobId,
            reportKey: `mock:${jobId}:filled`,
            executionSource: "CTRADER_MOCK",
            phase: "FILLED",
            occurredAt: now,
            dealTicket: `mock-deal-${jobId.slice(0, 8)}`,
            requestedPrice: new Prisma.Decimal(requested),
            filledPrice: new Prisma.Decimal(filled),
            filledVolume: new Prisma.Decimal(volume),
            spreadPoints: 2,
            latencyMs: 25,
            message: job.executionMode === "NEWS_REVERSAL"
              ? `${direction} three-target basket filled; fixed reversal placed beyond initial SL`
              : job.executionMode === "STRADDLE"
              ? `${direction} filled; sibling pending order cancelled (OCO)`
              : `${direction} market order filled`,
          },
        ],
      });
    });
  }

  private async advanceNewsReversal(jobId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const job = await tx.tradeJob.findUnique({ where: { id: jobId }, include: { legs: true } });
      if (!job || !job.activeDirection) return;
      const closed = job.legs.filter((leg) => leg.direction === job.activeDirection && leg.status === "CLOSED_TP").length;
      const nextTarget = closed + 1;
      const leg = job.legs.find((item) => item.direction === job.activeDirection && item.purpose === "INITIAL" &&
        item.targetNumber === nextTarget && item.status === "FILLED");
      if (!leg) return;
      await tx.tradeJobLeg.update({ where: { id: leg.id }, data: { status: "CLOSED_TP", closedAt: now } });
      if (nextTarget === 3) {
        await tx.tradeJob.update({ where: { id: jobId }, data: { status: "CLOSED", closedAt: now, newsReversalState: "COMPLETED" } });
      } else {
        await tx.tradeJob.update({ where: { id: jobId }, data: { status: "MANAGED",
          newsReversalState: nextTarget === 1 ? "TP1_PROTECTED" : "TP2_PROTECTED" } });
      }
      await tx.executionReport.create({ data: { jobId, reportKey: `mock:${jobId}:tp${nextTarget}`,
        executionSource: "CTRADER_MOCK", phase: nextTarget === 3 ? "CLOSED" : "ACCEPTED", occurredAt: now,
        message: nextTarget === 3 ? "Mock TP3 reached; reversal orders cancelled"
          : `Mock TP${nextTarget} reached; fixed reversal price unchanged and volume reduced` } });
    });
  }

  private async close(jobId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.tradeJob.updateMany({
        where: { id: jobId, status: "FILLED" },
        data: { status: "CLOSED", closedAt: now },
      });
      if (claimed.count !== 1) return;
      await tx.executionReport.create({
        data: {
          jobId,
          reportKey: `mock:${jobId}:closed`,
          executionSource: "CTRADER_MOCK",
          phase: "CLOSED",
          occurredAt: now,
          message: "Mock position closed by Take Profit",
        },
      });
    });
  }
}
