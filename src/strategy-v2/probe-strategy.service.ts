import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { atr, breakoutLevel, CandleValue, ema } from "./probe-strategy.math";
import type { Agent } from "../generated/prisma/client";
import { randomUUID } from "node:crypto";

export interface CandleInput {
  symbol: string;
  timeframe: "M15" | "H1";
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  spreadPoints?: number;
  source?: string;
  point?: number;
}

@Injectable()
export class ProbeStrategyService {
  constructor(private readonly prisma: PrismaService) {}

  async enableForUser(userId: string, cTraderAccountId: string, enabled: boolean) {
    const account = await this.prisma.cTraderAccount.findFirst({ where: { id: cTraderAccountId, userId } });
    if (!account) throw new NotFoundException("cTrader account not found");
    return this.prisma.strategyConfig.upsert({
      where: { userId_cTraderAccountId_symbol: { userId, cTraderAccountId, symbol: "XAUUSD" } },
      create: { userId, cTraderAccountId, symbol: "XAUUSD", enabled },
      update: { enabled },
    });
  }

  async enableForMt5User(userId: string, accountId: string, enabled: boolean) {
    const account = await this.prisma.tradingAccount.findFirst({ where: { id: accountId, userId } });
    if (!account) throw new NotFoundException("MT5 account not found");
    if (account.environment !== "DEMO") throw new BadRequestException("Strategy V2 is demo-only");
    return this.prisma.strategyConfig.upsert({
      where: { userId_accountId_symbol: { userId, accountId, symbol: "XAUUSD" } },
      create: { userId, accountId, executionVenue: "MT5", symbol: "XAUUSD", enabled },
      update: { enabled },
    });
  }

  async ingestFromMt5(agent: Agent, input: CandleInput, evaluate = true): Promise<void> {
    const account = await this.prisma.tradingAccount.findFirst({ where: { agentId: agent.id, userId: agent.userId } });
    if (!account) throw new NotFoundException("MT5 account not found");
    if (account.environment !== "DEMO") throw new BadRequestException("Strategy V2 candle ingestion is demo-only");
    await this.ingest({ ...input, source: `MT5:${account.id}` }, account.id, evaluate);
  }

  async statusForUser(userId: string) {
    return this.prisma.strategyConfig.findMany({
      where: { userId },
      include: {
        cTraderAccount: true,
        account: true,
        positions: { include: { events: { orderBy: { occurredAt: "asc" } } }, orderBy: { createdAt: "desc" }, take: 3 },
      },
    });
  }

  async ingest(input: CandleInput, accountId?: string, evaluate = true): Promise<void> {
    this.validateCandle(input);
    const source = input.source ?? "MOCK";
    await this.prisma.marketCandle.upsert({
      where: {
        symbol_timeframe_openTime_source: {
          symbol: input.symbol.toUpperCase(), timeframe: input.timeframe, openTime: input.openTime, source,
        },
      },
      create: {
        symbol: input.symbol.toUpperCase(),
        timeframe: input.timeframe,
        openTime: input.openTime,
        open: input.open,
        high: input.high,
        low: input.low,
        close: input.close,
        spreadPoints: input.spreadPoints ?? 0,
        source,
      },
      update: {
        open: input.open, high: input.high, low: input.low, close: input.close,
        spreadPoints: input.spreadPoints ?? 0,
      },
    });
    if (input.timeframe !== "M15" || !evaluate) return;
    const configs = await this.prisma.strategyConfig.findMany({
      where: {
        enabled: true,
        symbol: input.symbol.toUpperCase(),
        ...(accountId ? { executionVenue: "MT5", accountId } : { executionVenue: "CTRADER" }),
      },
    });
    for (const config of configs) await this.evaluate(config.id, input.openTime, source, input.point);
  }

  async runMockDemo(userId: string): Promise<void> {
    const config = await this.prisma.strategyConfig.findFirst({ where: { userId, enabled: true, executionVenue: "CTRADER" } });
    if (!config) throw new BadRequestException("Enable Strategy V2 first");
    const base = new Date(Date.now() - 220 * 60 * 60_000);
    const source = `DEMO_${Date.now()}`;
    for (let index = 0; index < 205; index += 1) {
      const close = 2_300 + index;
      await this.ingest({ symbol: config.symbol, timeframe: "H1", openTime: new Date(base.getTime() + index * 60 * 60_000), open: close - 0.3, high: close + 0.5, low: close - 0.5, close, source });
    }
    const m15Base = new Date(Date.now() - 24 * 15 * 60_000);
    for (let index = 0; index < 21; index += 1) {
      const close = 2_500 + index * 0.05;
      await this.ingest({ symbol: config.symbol, timeframe: "M15", openTime: new Date(m15Base.getTime() + index * 15 * 60_000), open: close - 0.05, high: close + 0.2, low: close - 0.2, close, spreadPoints: 10, source });
    }
    const level = 2_500 + 20 * 0.05 + 0.2;
    const breakoutTime = new Date(m15Base.getTime() + 21 * 15 * 60_000);
    await this.ingest({ symbol: config.symbol, timeframe: "M15", openTime: breakoutTime, open: level - 0.1, high: level + 0.5, low: level - 0.15, close: level + 0.3, spreadPoints: 10, source });
    await this.ingest({ symbol: config.symbol, timeframe: "M15", openTime: new Date(breakoutTime.getTime() + 15 * 60_000), open: level + 0.25, high: level + 0.7, low: level - 0.05, close: level + 0.45, spreadPoints: 10, source });
    const active = await this.prisma.strategyPosition.findFirst({
      where: { strategyConfigId: config.id, state: "MAIN_ADDED" }, orderBy: { createdAt: "desc" },
    });
    if (active) {
      await this.ingest({
        symbol: config.symbol, timeframe: "M15", openTime: new Date(breakoutTime.getTime() + 30 * 60_000),
        open: level + 0.5, high: Number(active.takeProfitPrice) + 0.1, low: level + 0.3,
        close: Number(active.takeProfitPrice), spreadPoints: 10, source,
      });
    }
  }

  private async evaluate(configId: string, candleTime: Date, source: string, point?: number): Promise<void> {
    const config = await this.prisma.strategyConfig.findUnique({ where: { id: configId } });
    if (!config?.enabled) return;
    const currentRecord = await this.prisma.marketCandle.findFirst({
      where: { symbol: config.symbol, timeframe: "M15", openTime: candleTime, source }, orderBy: { createdAt: "desc" },
    });
    if (!currentRecord) return;
    const current = this.toValue(currentRecord);
    const active = await this.prisma.strategyPosition.findFirst({
      where: { strategyConfigId: config.id, state: { in: ["PROBE_OPEN", "MAIN_ADDED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      await this.managePosition(active, current);
      return;
    }
    if (current.spreadPoints > config.maxSpreadPoints) return;
    const lastClosed = await this.prisma.strategyPosition.findFirst({
      where: { strategyConfigId: config.id, closedAt: { not: null } }, orderBy: { closedAt: "desc" },
    });
    if (lastClosed?.closedAt && candleTime.getTime() < lastClosed.closedAt.getTime() + config.cooldownBars * 15 * 60_000) return;

    const [h1Records, m15Records] = await Promise.all([
      this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "H1", source, openTime: { lte: candleTime } }, orderBy: { openTime: "desc" }, take: config.emaSlowPeriod + 20 }),
      this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "M15", source, openTime: { lt: candleTime } }, orderBy: { openTime: "desc" }, take: Math.max(config.breakoutPeriod, config.atrPeriod + 1) + 5 }),
    ]);
    const h1 = h1Records.reverse().map((item) => this.toValue(item));
    const previousM15 = m15Records.reverse().map((item) => this.toValue(item));
    if (h1.length < config.emaSlowPeriod || previousM15.length < Math.max(config.breakoutPeriod, config.atrPeriod + 1)) return;
    const fast = ema(h1.map((item) => item.close), config.emaFastPeriod);
    const slow = ema(h1.map((item) => item.close), config.emaSlowPeriod);
    const currentAtr = atr(previousM15, config.atrPeriod);
    if (current.high - current.low > 2.5 * currentAtr) return;

    const buyLevel = breakoutLevel(previousM15, config.breakoutPeriod, "BUY");
    const sellLevel = breakoutLevel(previousM15, config.breakoutPeriod, "SELL");
    const direction = fast > slow && current.close > buyLevel
      ? "BUY"
      : fast < slow && current.close < sellLevel ? "SELL" : null;
    if (!direction) return;
    const level = direction === "BUY" ? buyLevel : sellLevel;
    const riskDistance = currentAtr * Number(config.stopAtrMultiplier);
    const stop = current.close + (direction === "BUY" ? -riskDistance : riskDistance);
    const target = current.close + (direction === "BUY" ? riskDistance : -riskDistance) * Number(config.takeProfitR);
    const position = await this.prisma.strategyPosition.create({
      data: {
        userId: config.userId,
        cTraderAccountId: config.cTraderAccountId,
        accountId: config.accountId,
        executionVenue: config.executionVenue,
        strategyConfigId: config.id,
        symbol: config.symbol, direction, state: "PROBE_OPEN", breakoutLevel: level,
        atrAtEntry: currentAtr, probeEntryPrice: current.close, stopLossPrice: stop,
        takeProfitPrice: target, probeRiskPercent: config.probeRiskPercent,
        mainRiskPercent: config.mainRiskPercent,
        confirmationDeadline: new Date(candleTime.getTime() + config.confirmationBars * 15 * 60_000),
        openedAt: candleTime,
        events: { create: { type: "PROBE_FILLED", occurredAt: candleTime, price: current.close, message: `${direction} probe opened at 25% size` } },
      },
    });
    if (config.executionVenue === "MT5" && config.accountId) {
      await this.scheduleMt5Leg(position.id, config.userId, config.accountId, direction, current.close, stop, target, point, "PROBE");
    }
  }

  private async managePosition(position: { id: string; state: string; direction: string; breakoutLevel: Prisma.Decimal; atrAtEntry: Prisma.Decimal; probeEntryPrice: Prisma.Decimal; stopLossPrice: Prisma.Decimal; takeProfitPrice: Prisma.Decimal; confirmationDeadline: Date }, candle: CandleValue): Promise<void> {
    const buy = position.direction === "BUY";
    const stopHit = buy ? candle.low <= Number(position.stopLossPrice) : candle.high >= Number(position.stopLossPrice);
    const targetHit = buy ? candle.high >= Number(position.takeProfitPrice) : candle.low <= Number(position.takeProfitPrice);
    if (stopHit) {
      await this.closePosition(position.id, candle, "CLOSED_SL", Number(position.stopLossPrice), "Stop Loss", -1);
      return;
    }
    if (position.state === "MAIN_ADDED" && targetHit) {
      await this.closePosition(position.id, candle, "CLOSED_TP", Number(position.takeProfitPrice), "Take Profit", 3);
      return;
    }
    if (position.state !== "PROBE_OPEN") return;
    const level = Number(position.breakoutLevel);
    const atrValue = Number(position.atrAtEntry);
    const retestHeld = buy ? candle.low <= level && candle.close > level : candle.high >= level && candle.close < level;
    const momentumConfirmed = buy
      ? candle.close >= Number(position.probeEntryPrice) + 0.5 * atrValue
      : candle.close <= Number(position.probeEntryPrice) - 0.5 * atrValue;
    if (retestHeld || momentumConfirmed) {
      const updated = await this.prisma.strategyPosition.update({
        where: { id: position.id },
        data: {
          state: "MAIN_ADDED", mainEntryPrice: candle.close, mainAddedAt: candle.openTime,
          events: { create: { type: "MAIN_ADDED", occurredAt: candle.openTime, price: candle.close, message: "Confirmation received; remaining 75% added" } },
        },
      });
      const full = await this.prisma.strategyPosition.findUnique({ where: { id: updated.id } });
      if (full?.executionVenue === "MT5" && full.accountId) {
        await this.scheduleMt5Leg(full.id, full.userId, full.accountId, full.direction, candle.close,
          Number(full.stopLossPrice), Number(full.takeProfitPrice), undefined, "MAIN");
      }
      return;
    }
    if (candle.openTime >= position.confirmationDeadline) {
      const risk = Math.abs(Number(position.probeEntryPrice) - Number(position.stopLossPrice));
      const realizedR = (candle.close - Number(position.probeEntryPrice)) * (buy ? 1 : -1) / risk * 0.25;
      await this.closePosition(position.id, candle, "CLOSED_TIMEOUT", candle.close, "No confirmation within configured bars", realizedR);
    }
  }

  private async scheduleMt5Leg(positionId: string, userId: string, accountId: string, direction: "BUY" | "SELL", entry: number, stop: number, target: number, pointInput: number | undefined, leg: "PROBE" | "MAIN"): Promise<void> {
    const account = await this.prisma.tradingAccount.findFirst({ where: { id: accountId, userId, environment: "DEMO" } });
    if (!account) throw new BadRequestException("MT5 demo account is unavailable");
    const inferredPoint = entry >= 100 ? 0.01 : 0.0001;
    const point = pointInput && pointInput > 0 ? pointInput : inferredPoint;
    const stopLossPoints = Math.max(1, Math.round(Math.abs(entry - stop) / point));
    const takeProfitPoints = Math.max(1, Math.round(Math.abs(target - entry) / point));
    const executeAt = new Date(Date.now() + 10_000);
    await this.prisma.tradeJob.create({
      data: {
        userId, accountId, executionVenue: "MT5", idempotencyKey: `strategy-v2:${positionId}:${leg}`,
        symbol: "XAUUSD", direction, executionMode: "MARKET", riskMode: "FIXED_LOT", fixedLot: 0.01,
        stopLossPoints, takeProfitPoints, deviationPoints: 20, maxSpreadPoints: 100,
        armSeconds: 3, maxLatenessMs: 5_000, executeAt,
        expiresAt: new Date(executeAt.getTime() + 5_000), status: "SCHEDULED",
        settingsSnapshot: {
          protocolVersion: 2, strategy: "PROBE_ENTRY_V2", strategyPositionId: positionId,
          leg, demoOnly: true, expectedEntry: entry, sharedStop: stop, sharedTarget: target,
        },
      },
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return undefined;
      throw error;
    });
    await this.prisma.strategyEvent.create({
      data: {
        strategyPositionId: positionId, type: `MT5_${leg}_SCHEDULED`, occurredAt: new Date(), price: entry,
        message: `MT5 demo ${leg.toLowerCase()} order scheduled at fixed 0.01 lot`, metadata: { requestId: randomUUID() },
      },
    });
  }

  private async closePosition(id: string, candle: CandleValue, state: "CLOSED_TP" | "CLOSED_SL" | "CLOSED_TIMEOUT", price: number, reason: string, realizedR: number): Promise<void> {
    await this.prisma.strategyPosition.update({
      where: { id },
      data: {
        state, closedAt: candle.openTime, closePrice: price, closeReason: reason, realizedR,
        events: { create: { type: state, occurredAt: candle.openTime, price, message: reason } },
      },
    });
  }

  private toValue(value: { openTime: Date; open: Prisma.Decimal; high: Prisma.Decimal; low: Prisma.Decimal; close: Prisma.Decimal; spreadPoints: number }): CandleValue {
    return { openTime: value.openTime, open: Number(value.open), high: Number(value.high), low: Number(value.low), close: Number(value.close), spreadPoints: value.spreadPoints };
  }

  private validateCandle(input: CandleInput): void {
    if (![input.open, input.high, input.low, input.close].every(Number.isFinite)) throw new BadRequestException("Invalid candle price");
    if (input.low > Math.min(input.open, input.close) || input.high < Math.max(input.open, input.close) || input.low > input.high) {
      throw new BadRequestException("Invalid OHLC relationship");
    }
  }
}
