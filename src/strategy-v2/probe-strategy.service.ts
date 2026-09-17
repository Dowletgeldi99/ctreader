import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assessBreakoutQuality, atr, breakoutLevel, CandleValue, detectMarketRegime, detectWaveTrigger,
  directionalEfficiency, resolveBarrierOutcome, waveStop } from "./probe-strategy.math";
import type { Agent } from "../generated/prisma/client";
import { randomUUID } from "node:crypto";

export interface CandleInput {
  symbol: string;
  timeframe: "M5" | "M15" | "H1";
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  spreadPoints?: number;
  source?: string;
  point?: number;
  tickVolume?: number;
  isHistorical?: boolean;
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
    if (account.environment !== "DEMO") throw new BadRequestException("Strategy V4 is demo-only");
    return this.prisma.strategyConfig.upsert({
      where: { userId_accountId_symbol: { userId, accountId, symbol: "XAUUSD" } },
      create: { userId, accountId, executionVenue: "MT5", symbol: "XAUUSD", enabled },
      update: { enabled },
    });
  }

  async enableForCbotUser(userId: string, cbotInstanceId: string, enabled: boolean) {
    const instance = await this.prisma.cbotInstance.findFirst({ where: { id: cbotInstanceId, userId } });
    if (!instance) throw new NotFoundException("cBot instance not found");
    if (instance.environment !== "DEMO") throw new BadRequestException("Strategy V4 is demo-only");
    return this.prisma.strategyConfig.upsert({
      where: { userId_cbotInstanceId_symbol: { userId, cbotInstanceId, symbol: "XAUUSD" } },
      create: { userId, cbotInstanceId, executionVenue: "CBOT", symbol: "XAUUSD", enabled },
      update: { enabled },
    });
  }

  async ingestFromMt5(agent: Agent, input: CandleInput, evaluate = true): Promise<void> {
    const account = await this.prisma.tradingAccount.findFirst({ where: { agentId: agent.id, userId: agent.userId } });
    if (!account) throw new NotFoundException("MT5 account not found");
    if (account.environment !== "DEMO") throw new BadRequestException("Strategy V4 candle ingestion is demo-only");
    await this.ingest({ ...input, source: `MT5:${account.id}` }, account.id, evaluate);
  }

  async statusForUser(userId: string) {
    return this.prisma.strategyConfig.findMany({
      where: { userId },
      include: {
        cTraderAccount: true,
        account: true,
        positions: { include: { events: { orderBy: { occurredAt: "asc" } } }, orderBy: { createdAt: "desc" }, take: 3 },
        candidates: { orderBy: { candleTime: "desc" }, take: 3 },
      },
    });
  }

  async feedStatusForUser(userId: string) {
    const configs = await this.prisma.strategyConfig.findMany({
      where: { userId, enabled: true, cbotInstanceId: { not: null } },
      select: { id: true, cbotInstanceId: true, symbol: true },
    });
    return Promise.all(configs.map(async (config) => ({
      configId: config.id,
      cbotInstanceId: config.cbotInstanceId,
      candles: await Promise.all((["H1", "M15", "M5"] as const).map(async (timeframe) => {
        const candle = await this.prisma.marketCandle.findFirst({
          where: { symbol: config.symbol, timeframe, source: `CBOT:${config.cbotInstanceId}` },
          orderBy: { openTime: "desc" }, select: { openTime: true, close: true, tickVolume: true },
        });
        return { timeframe, openTime: candle?.openTime ?? null, close: candle?.close ?? null,
          tickVolume: candle?.tickVolume ?? null };
      })),
    })));
  }

  async waveStatusForUser(userId: string) {
    const configs = await this.prisma.strategyConfig.findMany({
      where: { userId, enabled: true, cbotInstanceId: { not: null } },
      select: { id: true, cbotInstanceId: true, symbol: true, emaFastPeriod: true, emaSlowPeriod: true,
        atrPeriod: true, breakoutPeriod: true, minEmaSeparationAtr: true, minEmaSlopeAtr: true },
    });
    return Promise.all(configs.map(async (config) => {
      const source = `CBOT:${config.cbotInstanceId}`;
      const [h1Records, m15Records, m5Records] = await Promise.all([
        this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "H1", source },
          orderBy: { openTime: "desc" }, take: 70 }),
        this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "M15", source },
          orderBy: { openTime: "desc" }, take: 40 }),
        this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "M5", source },
          orderBy: { openTime: "desc" }, take: 40 }),
      ]);
      const h1 = h1Records.reverse().map((item) => this.toValue(item));
      const m15 = m15Records.reverse().map((item) => this.toValue(item));
      const m5 = m5Records.reverse().map((item) => this.toValue(item));
      if (h1.length < 53 || m15.length < config.emaSlowPeriod + 3
        || m5.length < Math.max(config.atrPeriod + 1, config.breakoutPeriod, 12)) {
        return { configId: config.id, ready: false as const, state: "WARMUP" as const };
      }
      const h1Regime = detectMarketRegime(h1, 20, 50, config.atrPeriod, 0.50, 0.05);
      const m15Regime = detectMarketRegime(m15, config.emaFastPeriod, config.emaSlowPeriod, config.atrPeriod,
        Number(config.minEmaSeparationAtr), Number(config.minEmaSlopeAtr));
      const efficiency = directionalEfficiency(m5.slice(-12));
      const buyLevel = breakoutLevel(m5, config.breakoutPeriod, "BUY");
      const sellLevel = breakoutLevel(m5, config.breakoutPeriod, "SELL");
      const close = m5.at(-1)!.close;
      const state = m15Regime.regime === "RANGE" || efficiency < 0.25
        ? "CHOP" : m15Regime.regime === "TREND_UP" ? "ARMED_BUY" : "ARMED_SELL";
      return { configId: config.id, ready: true as const, state, h1Regime: h1Regime.regime, m15Regime: m15Regime.regime,
        efficiency, close, buyLevel, sellLevel };
    }));
  }

  async ingest(input: CandleInput, executionAccountId?: string, evaluate = true): Promise<void> {
    this.validateCandle(input);
    const source = input.source ?? "MOCK";
    const key = { symbol: input.symbol.toUpperCase(), timeframe: input.timeframe, openTime: input.openTime, source };
    const existing = await this.prisma.marketCandle.findUnique({
      where: { symbol_timeframe_openTime_source: key },
    });
    if (existing) {
      await this.prisma.marketCandle.update({ where: { id: existing.id }, data: {
        open: input.open, high: input.high, low: input.low, close: input.close,
        spreadPoints: input.spreadPoints, tickVolume: input.tickVolume,
        isHistorical: existing.isHistorical && (input.isHistorical ?? false),
      } });
      return;
    }
    await this.prisma.marketCandle.create({
      data: {
        symbol: input.symbol.toUpperCase(),
        timeframe: input.timeframe,
        openTime: input.openTime,
        open: input.open,
        high: input.high,
        low: input.low,
        close: input.close,
        spreadPoints: input.spreadPoints,
        tickVolume: input.tickVolume,
        isHistorical: input.isHistorical ?? false,
        source,
      },
    });
    if (input.timeframe !== "M5" || !evaluate || input.isHistorical) return;
    const configs = await this.prisma.strategyConfig.findMany({
      where: {
        enabled: true,
        symbol: input.symbol.toUpperCase(),
        ...(source.startsWith("CBOT:")
          ? { executionVenue: "CBOT", cbotInstanceId: executionAccountId }
          : executionAccountId ? { executionVenue: "MT5", accountId: executionAccountId } : { executionVenue: "CTRADER" }),
      },
    });
    for (const config of configs) await this.evaluateV4(config.id, input.openTime, source, input.point);
  }

  async runMockDemo(userId: string): Promise<void> {
    const config = await this.prisma.strategyConfig.findFirst({ where: { userId, enabled: true, executionVenue: "CTRADER" } });
    if (!config) throw new BadRequestException("Enable Strategy V4 first");
    const base = new Date(Date.now() - 70 * 60 * 60_000);
    const source = `DEMO_${Date.now()}`;
    for (let index = 0; index < 60; index += 1) {
      const close = 2_300 + index * 0.8;
      await this.ingest({ symbol: config.symbol, timeframe: "H1", openTime: new Date(base.getTime() + index * 60 * 60_000), open: close - 0.3, high: close + 0.5, low: close - 0.5, close, source });
    }
    const m15Base = new Date(Date.now() - 30 * 15 * 60_000);
    for (let index = 0; index < 25; index += 1) {
      const close = 2_348 + index * 0.04;
      await this.ingest({ symbol: config.symbol, timeframe: "M15", openTime: new Date(m15Base.getTime() + index * 15 * 60_000), open: close - 0.05, high: close + 0.2, low: close - 0.2, close, tickVolume: 100, source });
    }
    const level = 2_348 + 24 * 0.04 + 0.2;
    const m5Base = new Date(Date.now() - 20 * 5 * 60_000);
    for (let index = 0; index < 16; index += 1) {
      const close = level - 0.15 + index * 0.005;
      await this.ingest({ symbol: config.symbol, timeframe: "M5", openTime: new Date(m5Base.getTime() + index * 5 * 60_000),
        open: close - 0.02, high: close + 0.08, low: close - 0.08, close, tickVolume: 100, spreadPoints: 10, source });
    }
    const breakoutTime = new Date(m5Base.getTime() + 16 * 5 * 60_000);
    await this.ingest({ symbol: config.symbol, timeframe: "M5", openTime: breakoutTime,
      open: level - 0.08, high: level + 0.22, low: level - 0.10, close: level + 0.18,
      tickVolume: 160, spreadPoints: 10, source });
    await this.ingest({ symbol: config.symbol, timeframe: "M5", openTime: new Date(breakoutTime.getTime() + 5 * 60_000),
      open: level + 0.20, high: level + 0.45, low: level + 0.05, close: level + 0.40,
      tickVolume: 150, spreadPoints: 10, source });
    const active = await this.prisma.strategyPosition.findFirst({
      where: { strategyConfigId: config.id, state: "MAIN_ADDED" }, orderBy: { createdAt: "desc" },
    });
    if (active) {
      await this.ingest({
        symbol: config.symbol, timeframe: "M5", openTime: new Date(breakoutTime.getTime() + 10 * 60_000),
        open: level + 0.5, high: Number(active.takeProfitPrice) + 0.1, low: level + 0.3,
        close: Number(active.takeProfitPrice), spreadPoints: 10, tickVolume: 140, source,
      });
    }
  }

  private async evaluateV4(configId: string, candleTime: Date, source: string, point?: number): Promise<void> {
    const config = await this.prisma.strategyConfig.findUnique({ where: { id: configId } });
    if (!config?.enabled) return;
    const currentRecord = await this.prisma.marketCandle.findFirst({
      where: { symbol: config.symbol, timeframe: "M5", openTime: candleTime, source }, orderBy: { createdAt: "desc" },
    });
    if (!currentRecord) return;
    const current = this.toValue(currentRecord);
    await this.settleCandidates(config.id, source, current);
    const active = await this.prisma.strategyPosition.findFirst({
      where: { strategyConfigId: config.id, state: { in: ["PROBE_OPEN", "MAIN_ADDED"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      await this.managePosition(active, current);
      return;
    }
    const lastClosed = await this.prisma.strategyPosition.findFirst({
      where: { strategyConfigId: config.id, closedAt: { not: null } }, orderBy: { closedAt: "desc" },
    });
    if (lastClosed?.closedAt && candleTime.getTime() < lastClosed.closedAt.getTime() + config.cooldownBars * 5 * 60_000) return;

    const [h1Records, m15Records, m5Records] = await Promise.all([
      this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "H1", source,
        openTime: { lte: candleTime } }, orderBy: { openTime: "desc" }, take: 70 }),
      this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "M15", source,
        openTime: { lte: new Date(candleTime.getTime() - 15 * 60_000) } }, orderBy: { openTime: "desc" }, take: 40 }),
      this.prisma.marketCandle.findMany({ where: { symbol: config.symbol, timeframe: "M5", source, openTime: { lt: candleTime } }, orderBy: { openTime: "desc" }, take: Math.max(config.atrPeriod + 1, 30) + 5 }),
    ]);
    const h1 = h1Records.reverse().map((item) => this.toValue(item));
    const previousM15 = m15Records.reverse().map((item) => this.toValue(item));
    const previousM5 = m5Records.reverse().map((item) => this.toValue(item));
    if (h1.length < 53 || previousM15.length < config.emaSlowPeriod + 3
      || previousM5.length < Math.max(config.atrPeriod + 1, config.breakoutPeriod, 12)) return;
    const h1Regime = detectMarketRegime(h1, 20, 50, config.atrPeriod, 0.50, 0.05);
    const m15Regime = detectMarketRegime(previousM15, config.emaFastPeriod, config.emaSlowPeriod, config.atrPeriod,
      Number(config.minEmaSeparationAtr), Number(config.minEmaSlopeAtr));
    const currentAtr = atr(previousM5, config.atrPeriod);
    const m5Efficiency = directionalEfficiency(previousM5.slice(-12));
    if (m15Regime.regime === "RANGE" || m5Efficiency < 0.25) return;
    const bias = m15Regime.regime === "TREND_UP" ? "BUY" : "SELL";
    const signal = detectWaveTrigger({ bias, previous: previousM5, current, lookback: config.breakoutPeriod });
    if (!signal) return;
    const { direction, level, trigger } = signal;
    const stopResult = waveStop({ direction, previous: previousM5, current, atr: currentAtr,
      minDistanceAtr: Number(config.stopAtrMultiplier) });
    const stop = stopResult.stop;
    const target = current.close + (direction === "BUY" ? stopResult.distance : -stopResult.distance)
      * Number(config.takeProfitR);
    const labelExpiresAt = new Date(candleTime.getTime() + config.candidateLabelHorizonBars * 5 * 60_000);
    const quality = assessBreakoutQuality({
      candle: current, direction, level, atr: currentAtr,
      previousTickVolumes: previousM5.flatMap((candle) => candle.tickVolume === undefined ? [] : [candle.tickVolume]),
      minBodyRatio: Number(config.minBreakoutBodyRatio),
      minRangeAtr: 0.60,
      minCloseBeyondAtr: Number(config.minBreakoutCloseAtr),
      maxOppositeWickRatio: Number(config.maxOppositeWickRatio),
      maxRangeAtr: Number(config.maxBreakoutRangeAtr),
      minTickVolumeRatio: Number(config.minTickVolumeRatio),
    });
    const highVol = quality.rangeAtr >= 1.8;
    const regime = highVol ? "HIGH_VOL" : m15Regime.regime;
    const reasons = quality.reasons.map((reason) => reason === "HIGH_VOL_BREAKOUT" ? "EXTREME_VOLATILITY" : reason);
    const h1Opposes = direction === "BUY" ? h1Regime.regime === "TREND_DOWN" : h1Regime.regime === "TREND_UP";
    if (config.regimeFilterEnabled && h1Opposes) reasons.push("STRONG_H1_VETO");
    if (!stopResult.valid) reasons.push("STRUCTURAL_STOP_TOO_WIDE");
    if (current.spreadPoints !== undefined && config.maxSpreadPoints > 0 && current.spreadPoints > config.maxSpreadPoints) {
      reasons.push("SPREAD_TOO_WIDE");
    }
    const newsEvent = source.startsWith("DEMO_") || !config.newsGuardEnabled
      ? null
      : await this.findBlockingNews(candleTime, 5, config.newsGuardBeforeMinutes, config.newsGuardAfterMinutes);
    if (newsEvent) reasons.push("HIGH_IMPACT_USD_NEWS");
    const features: Prisma.InputJsonObject = {
      strategyVersion: "4.0", trigger, atr: currentAtr, h1Atr: h1Regime.atr,
      h1Regime: h1Regime.regime, h1EmaSeparationAtr: h1Regime.separationAtr,
      h1EmaSlopeAtr: h1Regime.slopeAtr, m15Regime: m15Regime.regime,
      emaFast: m15Regime.emaFast, emaSlow: m15Regime.emaSlow,
      emaSeparationAtr: m15Regime.separationAtr, emaSlopeAtr: m15Regime.slopeAtr,
      directionalEfficiency: m5Efficiency, stopDistanceAtr: stopResult.distanceAtr,
      breakoutLevel: level, breakoutRangeAtr: quality.rangeAtr, bodyRatio: quality.bodyRatio,
      oppositeWickRatio: quality.oppositeWickRatio, closeBeyondAtr: quality.closeBeyondAtr,
      tickVolume: current.tickVolume ?? null, tickVolumeRatio: quality.tickVolumeRatio ?? null,
      spreadPoints: current.spreadPoints ?? null, newsEventId: newsEvent?.id ?? null,
      newsTitle: newsEvent?.title ?? null,
    };
    if (reasons.length > 0) {
      await this.recordCandidate(config.id, config.symbol, source, candleTime, direction, regime, "SKIP", reasons,
        features, current.close, stop, target, labelExpiresAt);
      return;
    }
    await this.recordCandidate(config.id, config.symbol, source, candleTime, direction, regime, "EXECUTE", ["ACCEPTED"],
      features, current.close, stop, target, labelExpiresAt);
    const position = await this.prisma.strategyPosition.create({
      data: {
        userId: config.userId,
        cTraderAccountId: config.cTraderAccountId,
        accountId: config.accountId,
        cbotInstanceId: config.cbotInstanceId,
        executionVenue: config.executionVenue,
        strategyConfigId: config.id,
        symbol: config.symbol, direction, state: "PROBE_OPEN", breakoutLevel: level,
        atrAtEntry: currentAtr, probeEntryPrice: current.close, stopLossPrice: stop,
        takeProfitPrice: target, probeRiskPercent: config.probeRiskPercent,
        mainRiskPercent: config.mainRiskPercent,
        confirmationDeadline: new Date(candleTime.getTime() + config.confirmationBars * 5 * 60_000),
        openedAt: candleTime,
        events: { create: { type: "V4_WAVE_PROBE", occurredAt: candleTime, price: current.close,
          message: `${direction} ${trigger.toLowerCase()} probe scheduled from M5` } },
      },
    });
    if (config.executionVenue === "MT5" && config.accountId) {
      await this.scheduleMt5Leg(position.id, config.userId, config.accountId, direction, current.close, stop, target, point, "PROBE");
    } else if (config.executionVenue === "CBOT" && config.cbotInstanceId) {
      await this.scheduleCbotLeg(position.id, config.userId, config.cbotInstanceId, direction, current.close, stop, target, point, "PROBE");
    }
  }

  private findBlockingNews(candleTime: Date, timeframeMinutes: number, beforeMinutes: number, afterMinutes: number) {
    const signalTime = new Date(candleTime.getTime() + timeframeMinutes * 60_000);
    return this.prisma.economicEvent.findFirst({
      where: {
        currency: "USD", importance: "HIGH",
        scheduledAt: {
          gte: new Date(signalTime.getTime() - afterMinutes * 60_000),
          lte: new Date(signalTime.getTime() + beforeMinutes * 60_000),
        },
      },
      orderBy: { scheduledAt: "asc" },
      select: { id: true, title: true, scheduledAt: true },
    });
  }

  private async recordCandidate(configId: string, symbol: string, source: string, candleTime: Date,
    direction: "BUY" | "SELL", regime: string, decision: "EXECUTE" | "SKIP", reasons: string[],
    features: Prisma.InputJsonObject, entryPrice: number, stopLossPrice: number, takeProfitPrice: number,
    labelExpiresAt: Date): Promise<void> {
    await this.prisma.strategyCandidate.upsert({
      where: { strategyConfigId_source_candleTime: { strategyConfigId: configId, source, candleTime } },
      create: { strategyConfigId: configId, symbol, source, candleTime, direction, regime, decision,
        reason: reasons.join(","), features, entryPrice, stopLossPrice, takeProfitPrice, labelExpiresAt },
      update: { direction, regime, decision, reason: reasons.join(","), features,
        entryPrice, stopLossPrice, takeProfitPrice, labelExpiresAt },
    });
  }

  private async settleCandidates(configId: string, source: string, candle: CandleValue): Promise<void> {
    const candidates = await this.prisma.strategyCandidate.findMany({
      where: { strategyConfigId: configId, source, outcome: null, candleTime: { lt: candle.openTime } },
      orderBy: { candleTime: "asc" }, take: 100,
    });
    for (const candidate of candidates) {
      const outcome = resolveBarrierOutcome({
        direction: candidate.direction, stopLoss: Number(candidate.stopLossPrice),
        takeProfit: Number(candidate.takeProfitPrice), candle,
      }) ?? (candle.openTime >= candidate.labelExpiresAt ? "TIMEOUT" : undefined);
      if (!outcome) continue;
      await this.prisma.strategyCandidate.updateMany({
        where: { id: candidate.id, outcome: null }, data: { outcome, resolvedAt: candle.openTime },
      });
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
    if (targetHit) {
      const risk = Math.abs(Number(position.probeEntryPrice) - Number(position.stopLossPrice));
      const targetR = Math.abs(Number(position.takeProfitPrice) - Number(position.probeEntryPrice)) / risk;
      await this.closePosition(position.id, candle, "CLOSED_TP", Number(position.takeProfitPrice), "Take Profit", targetR);
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
          events: { create: { type: "MAIN_ADDED", occurredAt: candle.openTime, price: candle.close,
            message: "M5 confirmation received; second 0.01 lot leg added" } },
        },
      });
      const full = await this.prisma.strategyPosition.findUnique({ where: { id: updated.id } });
      if (full?.executionVenue === "MT5" && full.accountId) {
        await this.scheduleMt5Leg(full.id, full.userId, full.accountId, full.direction, candle.close,
          Number(full.stopLossPrice), Number(full.takeProfitPrice), undefined, "MAIN");
      } else if (full?.executionVenue === "CBOT" && full.cbotInstanceId) {
        await this.scheduleCbotLeg(full.id, full.userId, full.cbotInstanceId, full.direction, candle.close,
          Number(full.stopLossPrice), Number(full.takeProfitPrice), undefined, "MAIN");
      }
      return;
    }
    if (candle.openTime >= position.confirmationDeadline) {
      const risk = Math.abs(Number(position.probeEntryPrice) - Number(position.stopLossPrice));
      const realizedR = (candle.close - Number(position.probeEntryPrice)) * (buy ? 1 : -1) / risk * 0.5;
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

  private async scheduleCbotLeg(positionId: string, userId: string, cbotInstanceId: string,
    direction: "BUY" | "SELL", entry: number, stop: number, target: number, pointInput: number | undefined,
    leg: "PROBE" | "MAIN"): Promise<void> {
    const instance = await this.prisma.cbotInstance.findFirst({
      where: { id: cbotInstanceId, userId, environment: "DEMO", status: "ONLINE" },
    });
    if (!instance) throw new BadRequestException("cBot demo instance is unavailable");
    const inferredPoint = entry >= 100 ? 0.01 : 0.0001;
    const point = pointInput && pointInput > 0 ? pointInput : inferredPoint;
    const stopLossPoints = Math.max(1, Math.round(Math.abs(entry - stop) / point));
    const takeProfitPoints = Math.max(1, Math.round(Math.abs(target - entry) / point));
    const executeAt = new Date(Date.now() + 3_000);
    await this.prisma.tradeJob.create({
      data: {
        userId, cbotInstanceId, executionVenue: "CBOT", idempotencyKey: `strategy-v4:${positionId}:${leg}`,
        symbol: instance.symbol, direction, executionMode: "MARKET", riskMode: "FIXED_LOT", fixedLot: 0.01,
        stopLossPoints, takeProfitPoints, deviationPoints: 20, maxSpreadPoints: 0,
        armSeconds: 2, maxLatenessMs: 10_000, executeAt,
        expiresAt: new Date(executeAt.getTime() + 10_000), status: "SCHEDULED",
        settingsSnapshot: {
          protocolVersion: 2, strategy: "PROBE_ENTRY_V4", strategyPositionId: positionId,
          leg, demoOnly: true, expectedEntry: entry, sharedStop: stop, sharedTarget: target,
        },
      },
    }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return undefined;
      throw error;
    });
    await this.prisma.strategyEvent.create({
      data: {
        strategyPositionId: positionId, type: `CBOT_${leg}_SCHEDULED`, occurredAt: new Date(), price: entry,
        message: `Strategy V4 cBot demo ${leg.toLowerCase()} order scheduled at fixed 0.01 lot`, metadata: { requestId: randomUUID() },
      },
    });
  }

  private async closePosition(id: string, candle: CandleValue, state: "CLOSED_TP" | "CLOSED_SL" | "CLOSED_TIMEOUT", price: number, reason: string, realizedR: number): Promise<void> {
    if (state === "CLOSED_TIMEOUT") {
      await this.prisma.tradeJob.updateMany({
        where: {
          executionVenue: "CBOT",
          settingsSnapshot: { path: ["strategyPositionId"], equals: id },
          status: { in: ["SCHEDULED", "SYNCED", "ARMED", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "MANAGED"] },
        },
        data: { closeRequestedAt: new Date() },
      });
    }
    await this.prisma.strategyPosition.update({
      where: { id },
      data: {
        state, closedAt: candle.openTime, closePrice: price, closeReason: reason, realizedR,
        events: { create: { type: state, occurredAt: candle.openTime, price, message: reason } },
      },
    });
  }

  private toValue(value: { openTime: Date; open: Prisma.Decimal; high: Prisma.Decimal; low: Prisma.Decimal; close: Prisma.Decimal; spreadPoints: number | null; tickVolume: Prisma.Decimal | null }): CandleValue {
    return { openTime: value.openTime, open: Number(value.open), high: Number(value.high), low: Number(value.low),
      close: Number(value.close), spreadPoints: value.spreadPoints ?? undefined,
      tickVolume: value.tickVolume === null ? undefined : Number(value.tickVolume) };
  }

  private validateCandle(input: CandleInput): void {
    if (![input.open, input.high, input.low, input.close].every(Number.isFinite)) throw new BadRequestException("Invalid candle price");
    if (input.low > Math.min(input.open, input.close) || input.high < Math.max(input.open, input.close) || input.low > input.high) {
      throw new BadRequestException("Invalid OHLC relationship");
    }
    if (input.spreadPoints !== undefined && (!Number.isInteger(input.spreadPoints) || input.spreadPoints < 0)) {
      throw new BadRequestException("Invalid spread points");
    }
    if (input.tickVolume !== undefined && (!Number.isFinite(input.tickVolume) || input.tickVolume < 0)) {
      throw new BadRequestException("Invalid tick volume");
    }
  }
}
