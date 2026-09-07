import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ExecutionPhase, Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CTraderService } from "./ctrader.service";
import { CTraderJsonClient, CTraderMessage } from "./ctrader-json-client";
import { calculateRiskVolumeInCents } from "./ctrader-risk";
import { SafetyService } from "../safety/safety.service";
import { randomUUID } from "crypto";
import { allocateNewsReversalVolume } from "./news-reversal-volume";
import { fixedReversalPrice, reversalTargetsAfter } from "./news-reversal-state";

interface Runtime {
  client: CTraderJsonClient;
  accountId: string;
  ctid: string;
  symbolId: string;
  buyOrderId?: string;
  sellOrderId?: string;
  orderIds: string[];
  executionMode: string;
  openPositions: Set<string>;
  filled: boolean;
  haltHandled?: boolean;
  expiry?: NodeJS.Timeout;
  execute?: NodeJS.Timeout;
  management?: NodeJS.Timeout;
  protectionSync?: NodeJS.Timeout;
  digits?: number;
  point?: number;
  lotSize?: number;
}
type JobWithAccount = Prisma.TradeJobGetPayload<{ include: { cTraderAccount: { include: { connection: true } }; user: { include: { settings: true } } } }>;
interface ReportExtra { orderTicket?: string; dealTicket?: string; filledPrice?: number; filledVolume?: number }

@Injectable()
export class CTraderExecutionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CTraderExecutionService.name);
  private readonly enabled: boolean;
  private readonly allowRealTrading: boolean;
  private timer?: NodeJS.Timeout;
  private leaseTimer?: NodeJS.Timeout;
  private safetyTimer?: NodeJS.Timeout;
  private busy = false;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly startingJobs = new Set<string>();
  private readonly managingJobs = new Set<string>();
  private readonly workerId = randomUUID();
  private readonly leaseMs: number;
  private readonly maxOpenPositionsPerUser: number;
  private readonly marginBufferMultiplier: number;
  private readonly maxRiskPercent: number;

  constructor(private readonly prisma: PrismaService, private readonly cTrader: CTraderService,
    private readonly safety: SafetyService, config: ConfigService) {
    this.enabled = (config.get<boolean>("CTRADER_ENABLED") ?? false) && !(config.get<boolean>("CTRADER_MOCK_MODE") ?? false);
    this.allowRealTrading = config.get<boolean>("ALLOW_REAL_TRADING") ?? false;
    this.leaseMs = (config.get<number>("CTRADER_JOB_LEASE_SECONDS") ?? 45) * 1_000;
    this.maxOpenPositionsPerUser = config.get<number>("MAX_OPEN_POSITIONS_PER_USER") ?? 10;
    this.marginBufferMultiplier = 1 + (config.get<number>("CTRADER_MARGIN_BUFFER_PERCENT") ?? 25) / 100;
    this.maxRiskPercent = config.get<number>("MAX_RISK_PERCENT") ?? 0.5;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.tick(), 250); this.timer.unref();
    this.leaseTimer = setInterval(() => void this.renewLeases(), Math.max(5_000, Math.floor(this.leaseMs / 3)));
    this.leaseTimer.unref();
    this.safetyTimer = setInterval(() => void this.enforceKillSwitch(), 1_000);
    this.safetyTimer.unref();
    this.logger.log("cTrader Open API execution worker started");
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    for (const runtime of this.runtimes.values()) this.closeRuntime(runtime);
  }

  private async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try {
      const now = new Date();
      await this.enforceUserRequests();
      const jobs = await this.prisma.tradeJob.findMany({
        where: { executionVenue: "CTRADER",
          OR: [
            { status: "SCHEDULED" },
            { status: { in: ["ARMED", "SUBMITTED", "FILLED", "PARTIALLY_FILLED", "MANAGED"] },
              OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
          ],
          executeAt: { lte: new Date(now.getTime() + 60_000) }, expiresAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } },
        include: { cTraderAccount: { include: { connection: true } }, user: { include: { settings: true } } }, take: 25, orderBy: { executeAt: "asc" },
      });
      for (const job of jobs) {
        if (this.runtimes.has(job.id) || this.startingJobs.has(job.id) || now.getTime() < job.executeAt.getTime() - job.armSeconds * 1_000) continue;
        if (job.status === "SCHEDULED") {
          const claimed = await this.prisma.tradeJob.updateMany({ where: { id: job.id, status: "SCHEDULED" },
            data: { status: "ARMED", armedAt: now, leaseOwner: this.workerId, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) } });
          if (claimed.count !== 1) continue;
          await this.report(job.id, `ctrader:${job.id}:armed`, "ARMED", "cTrader Open API execution armed");
        } else {
          const claimed = await this.prisma.tradeJob.updateMany({ where: { id: job.id, status: job.status,
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
          data: { leaseOwner: this.workerId, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) } });
          if (claimed.count !== 1) continue;
        }
        // Authentication and symbol discovery can take several polling cycles.
        // Claim the job in memory before starting any async work so the next
        // tick cannot create another socket and submit the same order again.
        this.startingJobs.add(job.id);
        void this.start(job)
          .catch((error) => void this.handleStartFailure(job.id, error))
          .finally(() => this.startingJobs.delete(job.id));
      }
    } catch (error) { this.logger.error("cTrader execution tick failed", error); }
    finally { this.busy = false; }
  }

  private async start(job: JobWithAccount): Promise<void> {
    await this.safety.assertTradingOpen();
    const account = job.cTraderAccount;
    if (!account?.enabled) throw new Error("cTrader account is disabled");
    if (account.environment === "LIVE" && (!this.allowRealTrading || !job.user.settings?.realTradingEnabled))
      throw new Error("cTrader LIVE execution requires system and user real-trading permission");
    const token = await this.cTrader.accessTokenForConnection(account.connectionId);
    const client = new CTraderJsonClient(account.environment === "LIVE" ? "live" : "demo");
    await client.connect();
    const credentials = this.cTrader.credentials();
    await client.request(2100, credentials, [2101]);
    const ctid = account.ctidTraderAccountId.toString();
    const ctidNumber = this.safeId(ctid, "ctidTraderAccountId");
    await client.request(2102, { ctidTraderAccountId: ctidNumber, accessToken: token }, [2103]);
    const traderResponse = await client.request(2121, { ctidTraderAccountId: ctidNumber }, [2122]);
    const trader = traderResponse.payload?.trader as Record<string, unknown> | undefined;
    if (!trader || Number(trader.accessRights ?? 0) !== 0) throw new Error("cTrader account does not grant full trading access");
    if (["MULTI", "NEWS_REVERSAL"].includes(job.executionMode) && Number(trader.accountType ?? 0) !== 0)
      throw new Error(`cTrader ${job.executionMode} requires a HEDGED account`);
    const reconciled = await client.request(2124, { ctidTraderAccountId: ctidNumber, returnProtectionOrders: false }, [2125]);
    const allPositions = (reconciled.payload?.position ?? []) as Array<Record<string, unknown>>;
    const prefix = `tg-${job.id.slice(0, 12)}`;
    const existingOrders = ((reconciled.payload?.order ?? []) as Array<Record<string, unknown>>).filter((order) =>
      String((order.tradeData as Record<string, unknown> | undefined)?.label ?? "").startsWith(prefix));
    const existingPositions = ((reconciled.payload?.position ?? []) as Array<Record<string, unknown>>).filter((position) =>
      String((position.tradeData as Record<string, unknown> | undefined)?.label ?? "").startsWith(prefix));
    if (existingOrders.length || existingPositions.length) {
      const firstTradeData = (existingOrders[0]?.tradeData ?? existingPositions[0]?.tradeData) as Record<string, unknown>;
      const runtime: Runtime = { client, accountId: account.id, ctid, symbolId: String(firstTradeData.symbolId), filled: existingPositions.length > 0,
        orderIds: existingOrders.map((order) => String(order.orderId)), executionMode: job.executionMode,
        openPositions: new Set(existingPositions.map((position) => String(position.positionId))) };
      runtime.buyOrderId = String(existingOrders.find((order) => String((order.tradeData as Record<string, unknown>)?.label).endsWith("-B"))?.orderId ?? "") || undefined;
      runtime.sellOrderId = String(existingOrders.find((order) => String((order.tradeData as Record<string, unknown>)?.label).endsWith("-S"))?.orderId ?? "") || undefined;
      this.runtimes.set(job.id, runtime); client.onMessage((message) => void this.onMessage(job.id, message));
      client.onClose((error) => void this.handleDisconnect(job.id, error));
      runtime.expiry = setTimeout(() => void this.expire(job.id), Math.max(0, job.expiresAt.getTime() - Date.now()));
      if (job.managementExpiresAt)
        runtime.management = setTimeout(() => void this.expireManagement(job.id), Math.max(0, job.managementExpiresAt.getTime() - Date.now()));
      if (job.executionMode === "NEWS_REVERSAL") await this.reconcileNewsReversal(job.id, runtime, existingOrders, existingPositions);
      await this.report(job.id, `ctrader:${job.id}:recovered:${Date.now()}`, "ERROR", `Recovered ${existingOrders.length} orders and ${existingPositions.length} positions after restart`);
      return;
    }
    if (["FILLED", "PARTIALLY_FILLED", "MANAGED"].includes(job.status)) {
      await this.prisma.tradeJob.updateMany({
        where: { id: job.id, status: { in: ["FILLED", "PARTIALLY_FILLED", "MANAGED"] } },
        data: { status: "CLOSED", closedAt: new Date() },
      });
      await this.report(job.id, `ctrader:${job.id}:closed:reconcile`, "CLOSED", "No open cTrader position remains; job closed during reconciliation");
      client.close();
      return;
    }
    if (!["SCHEDULED", "ARMED"].includes(job.status)) throw new Error(`No cTrader orders found while recovering job in ${job.status}`);
    const list = await client.request(2114, { ctidTraderAccountId: ctidNumber, includeArchivedSymbols: false }, [2115]);
    const light = ((list.payload?.symbol ?? []) as Array<Record<string, unknown>>).find((item) =>
      String(item.symbolName ?? item.name ?? "").replace("/", "").toUpperCase() === job.symbol.replace("/", "").toUpperCase(),
    );
    if (!light?.symbolId) throw new Error(`Symbol ${job.symbol} was not found in cTrader account`);
    const symbolId = String(light.symbolId);
    const symbolIdNumber = this.safeId(symbolId, "symbolId");
    const detail = await client.request(2116, { ctidTraderAccountId: ctidNumber, symbolId: [symbolIdNumber] }, [2117]);
    const symbol = ((detail.payload?.symbol ?? []) as Array<Record<string, unknown>>)[0];
    if (!symbol) throw new Error(`Symbol details for ${job.symbol} are unavailable`);
    const digits = Number(symbol.digits ?? 2); const point = 10 ** -digits;
    const lotSize = Number(symbol.lotSize ?? 0); const stepVolume = Number(symbol.stepVolume ?? 1);
    let requestedVolume: number;
    if (job.riskMode === "FIXED_LOT") {
      if (!job.fixedLot) throw new Error("Fixed lot is missing");
      requestedVolume = Math.round(Number(job.fixedLot) * lotSize);
    } else {
      if (!job.riskPercent) throw new Error("Risk percent is missing");
      if (String(light.quoteAssetId) !== String(trader.depositAssetId))
        throw new Error("Risk % currently requires account currency to match the symbol quote currency");
      const balance = Number(trader.balance ?? 0) / 10 ** Number(trader.moneyDigits ?? 2);
      const legs = job.executionMode === "MULTI" ? (job.multiTradesPerSide ?? 2) : job.executionMode === "STRADDLE" ? 1 : 0;
      const totalStopDistance = job.executionMode === "MULTI"
        ? 2 * (job.stopLossPoints + Math.max(0, legs - 1) * (job.multiNextSlPoints ?? job.stopLossPoints)) * point
        : (job.executionMode === "STRADDLE" ? 2 : 1) * job.stopLossPoints * point;
      requestedVolume = calculateRiskVolumeInCents({ balance, riskPercent: Number(job.riskPercent), totalStopDistance,
        minVolume: Number(symbol.minVolume ?? 1), maxVolume: Number(symbol.maxVolume ?? Number.MAX_SAFE_INTEGER), stepVolume });
    }
    const volume = job.riskMode === "RISK_PERCENT" ? requestedVolume : Math.round(requestedVolume / stepVolume) * stepVolume;
    if (volume < Number(symbol.minVolume ?? 1)) throw new Error("Calculated risk volume is below the broker minimum");
    if (volume > Number(symbol.maxVolume ?? Number.MAX_SAFE_INTEGER)) throw new Error("Calculated volume exceeds the broker maximum");
    if (!Number.isSafeInteger(volume) || volume <= 0) throw new Error("Calculated cTrader volume is invalid");
    await this.assertPositionLimit(job, allPositions);
    if (job.user.settings?.riskLimitEnabled) this.assertEstimatedRisk(job, trader, light, volume, point);
    await this.assertMargin(client, ctidNumber, symbolIdNumber, volume, job, trader, allPositions);
    const runtime: Runtime = { client, accountId: account.id, ctid, symbolId, filled: false,
      orderIds: [], executionMode: job.executionMode, openPositions: new Set(), digits, point, lotSize };
    this.runtimes.set(job.id, runtime);
    client.onMessage((message) => void this.onMessage(job.id, message));
    client.onClose((error) => void this.handleDisconnect(job.id, error));
    const spotPromise = this.waitForSpot(client, ctid, symbolId);
    await client.request(2127, { ctidTraderAccountId: ctidNumber, symbolId: [symbolIdNumber], subscribeToSpotTimestamp: true }, [2128]);
    const spot = await spotPromise;
    const common = { ctidTraderAccountId: ctidNumber, symbolId: symbolIdNumber, volume };
    if (job.executionMode === "NEWS_REVERSAL") {
      const mode = job.volumeAllocationMode ?? "SPLIT_TOTAL";
      const allocation = allocateNewsReversalVolume(volume, stepVolume, mode, 3);
      const targets = [job.takeProfitPoints, job.takeProfit2Points!, job.takeProfit3Points!];
      for (const side of [1, 2]) {
        const direction = side === 1 ? "BUY" : "SELL";
        const entry = this.round(side === 1
          ? spot.ask + job.entryDistancePoints * point
          : spot.bid - job.entryDistancePoints * point, digits);
        for (let index = 0; index < 3; index += 1) {
          const legVolume = allocation.legs[index];
          const target = targets[index];
          const slPrice = this.round(direction === "BUY" ? entry - job.stopLossPoints * point : entry + job.stopLossPoints * point, digits);
          const tpPrice = this.round(direction === "BUY" ? entry + target * point : entry - target * point, digits);
          const leg = await this.prisma.tradeJobLeg.upsert({
            where: { jobId_purpose_direction_targetNumber_revision: {
              jobId: job.id, purpose: "INITIAL", direction, targetNumber: index + 1, revision: 0,
            } },
            update: { plannedVolume: legVolume / lotSize, entryPrice: entry, stopLossPrice: slPrice, takeProfitPrice: tpPrice, status: "PLANNED" },
            create: { jobId: job.id, purpose: "INITIAL", direction, targetNumber: index + 1,
              revision: 0, legNumber: index + 1, plannedVolume: legVolume / lotSize, entryPrice: entry,
              stopLossPrice: slPrice, takeProfitPrice: tpPrice },
          });
          const orderId = await this.place(job.id, client, { ...common, volume: legVolume, orderType: 3, tradeSide: side,
            stopPrice: entry, relativeStopLoss: Math.round(job.stopLossPoints * point * 100_000),
            relativeTakeProfit: Math.round(target * point * 100_000), timeInForce: 1,
            expirationTimestamp: job.managementExpiresAt?.getTime() ?? job.expiresAt.getTime(),
            label: this.label(job.id, `NR-I-${side === 1 ? "B" : "S"}${index + 1}`),
            clientOrderId: `${job.id.slice(0, 22)}I${side === 1 ? "B" : "S"}${index + 1}` });
          runtime.orderIds.push(orderId);
          await this.prisma.tradeJobLeg.update({ where: { id: leg.id }, data: { brokerOrderId: orderId, status: "SUBMITTED" } });
        }
      }
      runtime.expiry = setTimeout(() => void this.expire(job.id), Math.max(0, job.expiresAt.getTime() - Date.now()));
      if (job.managementExpiresAt)
        runtime.management = setTimeout(() => void this.expireManagement(job.id), Math.max(0, job.managementExpiresAt.getTime() - Date.now()));
    } else if (job.executionMode === "MULTI") {
      const count = job.multiTradesPerSide ?? 2;
      for (let level = 0; level < count; level += 1) {
        const distancePoints = job.entryDistancePoints + level * (job.multiNextStepPoints ?? job.entryDistancePoints);
        const slPoints = level === 0 ? job.stopLossPoints : (job.multiNextSlPoints ?? job.stopLossPoints);
        const tpPoints = job.takeProfitPoints + level * (job.multiNextTpPoints ?? job.takeProfitPoints);
        for (const side of [1, 2]) {
          const sideCode = side === 1 ? "B" : "S";
          const orderId = await this.place(job.id, client, { ...common, orderType: 3, tradeSide: side,
            stopPrice: this.round(side === 1 ? spot.ask + distancePoints * point : spot.bid - distancePoints * point, digits),
            relativeStopLoss: Math.round(slPoints * point * 100_000), relativeTakeProfit: Math.round(tpPoints * point * 100_000),
            timeInForce: 1, expirationTimestamp: job.expiresAt.getTime(), label: this.label(job.id, `${sideCode}${level + 1}`),
            clientOrderId: `${job.id.slice(0, 28)}${sideCode}${level + 1}` });
          runtime.orderIds.push(orderId);
        }
      }
      runtime.expiry = setTimeout(() => void this.expire(job.id), Math.max(0, job.expiresAt.getTime() - Date.now()));
    } else if (job.executionMode === "STRADDLE") {
      const distance = job.entryDistancePoints * point;
      runtime.buyOrderId = await this.place(job.id, client, { ...common, orderType: 3, tradeSide: 1,
        relativeStopLoss: Math.round(job.stopLossPoints * point * 100_000), relativeTakeProfit: Math.round(job.takeProfitPoints * point * 100_000),
        stopPrice: this.round(spot.ask + distance, digits), timeInForce: 1, expirationTimestamp: job.expiresAt.getTime(),
        label: this.label(job.id, "B"), clientOrderId: `${job.id.slice(0, 32)}B` });
      runtime.orderIds.push(runtime.buyOrderId);
      runtime.sellOrderId = await this.place(job.id, client, { ...common, orderType: 3, tradeSide: 2,
        relativeStopLoss: Math.round(job.stopLossPoints * point * 100_000), relativeTakeProfit: Math.round(job.takeProfitPoints * point * 100_000),
        stopPrice: this.round(spot.bid - distance, digits), timeInForce: 1, expirationTimestamp: job.expiresAt.getTime(),
        label: this.label(job.id, "S"), clientOrderId: `${job.id.slice(0, 32)}S` });
      runtime.orderIds.push(runtime.sellOrderId);
      runtime.expiry = setTimeout(() => void this.expire(job.id), Math.max(0, job.expiresAt.getTime() - Date.now()));
    } else {
      runtime.execute = setTimeout(() => void this.place(job.id, client, { ...common, orderType: 1,
        relativeStopLoss: Math.round(job.stopLossPoints * point * 100_000), relativeTakeProfit: Math.round(job.takeProfitPoints * point * 100_000),
        tradeSide: job.direction === "BUY" ? 1 : 2, label: this.label(job.id, "M"), clientOrderId: job.id.slice(0, 32) })
        .catch((error) => void this.handleStartFailure(job.id, error)), Math.max(0, job.executeAt.getTime() - Date.now()));
    }
  }

  private async place(jobId: string, client: CTraderJsonClient, payload: Record<string, unknown>): Promise<string> {
    await this.safety.assertTradingOpen();
    const response = await client.request(2106, payload, [2126], 20_000);
    const orderId = String((response.payload?.order as Record<string, unknown> | undefined)?.orderId ?? "");
    if (!orderId) throw new Error(`${response.payload?.errorCode ?? "ORDER_REJECTED"}: cTrader returned no orderId`);
    await this.prisma.tradeJob.updateMany({ where: { id: jobId, status: { in: ["ARMED", "SUBMITTED"] } }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    await this.report(jobId, `ctrader:${jobId}:submitted:${orderId}`, "SUBMITTED", "cTrader order accepted", { orderTicket: orderId });
    return orderId;
  }

  private async onMessage(jobId: string, message: CTraderMessage): Promise<void> {
    const runtime = this.runtimes.get(jobId); if (!runtime) return;
    if ([50, 2142, 2132].includes(message.payloadType)) {
      await this.report(jobId, `ctrader:${jobId}:error:${Date.now()}`, "ERROR", `${message.payload?.errorCode ?? "CTRADER_ERROR"}: ${message.payload?.description ?? "Request failed"}`); return;
    }
    if (message.payloadType !== 2126 || String(message.payload?.ctidTraderAccountId) !== runtime.ctid) return;
    const order = message.payload?.order as Record<string, unknown> | undefined;
    const deal = message.payload?.deal as Record<string, unknown> | undefined;
    const label = String((order?.tradeData as Record<string, unknown> | undefined)?.label ?? "");
    if (!label.startsWith(`tg-${jobId.slice(0, 12)}`)) return;
    const executionType = Number(message.payload?.executionType);
    if (executionType === 3 || executionType === 11) {
      const position = message.payload?.position as Record<string, unknown> | undefined;
      if (Number(position?.positionStatus) === 2) {
        runtime.openPositions.delete(String(position?.positionId ?? ""));
        if (runtime.executionMode === "NEWS_REVERSAL") {
          await this.recordNewsReversalClose(jobId, order, deal, position);
          this.scheduleProtectionSync(jobId);
        }
        await this.report(jobId, `ctrader:${jobId}:closed:${deal?.dealId ?? Date.now()}`, "CLOSED", "cTrader position closed by broker protection");
        if (runtime.openPositions.size === 0 && Date.now() >= (await this.jobExpiry(jobId))) {
          await this.prisma.tradeJob.updateMany({ where: { id: jobId, status: { in: ["FILLED", "PARTIALLY_FILLED", "MANAGED", "CLOSED"] } }, data: { status: "CLOSED", closedAt: new Date() } });
          this.finish(jobId);
        }
        return;
      }
      const firstFill = !runtime.filled; runtime.filled = true;
      await this.prisma.tradeJob.updateMany({ where: { id: jobId, status: { in: ["ARMED", "SUBMITTED", "PARTIALLY_FILLED"] } }, data: { status: "FILLED", filledAt: new Date() } });
      await this.report(jobId, `ctrader:${jobId}:filled:${deal?.dealId ?? Date.now()}`, "FILLED", "cTrader order filled", {
        orderTicket: String(order?.orderId ?? ""), dealTicket: String(deal?.dealId ?? ""),
        filledPrice: Number(deal?.executionPrice ?? order?.executionPrice), filledVolume: Number(deal?.filledVolume ?? 0) / 100,
      });
      if (position?.positionId !== undefined) runtime.openPositions.add(String(position.positionId));
      if (runtime.executionMode === "NEWS_REVERSAL") {
        await this.recordNewsReversalFill(jobId, order, deal, position);
        this.scheduleProtectionSync(jobId);
      }
      if (firstFill && runtime.executionMode === "STRADDLE") {
        const filledOrder = String(order?.orderId ?? ""); const sibling = filledOrder === runtime.buyOrderId ? runtime.sellOrderId : runtime.buyOrderId;
        if (sibling) void this.cancel(runtime, sibling).catch((error) => this.logger.warn(`cTrader OCO cancel failed: ${error}`));
      }
    }
  }

  private async cancel(runtime: Runtime, orderId: string): Promise<void> {
    await runtime.client.request(2108, { ctidTraderAccountId: this.safeId(runtime.ctid, "ctidTraderAccountId"),
      orderId: this.safeId(orderId, "orderId") }, [2126]);
  }

  private async recordNewsReversalFill(jobId: string, order: Record<string, unknown> | undefined,
    deal: Record<string, unknown> | undefined, position: Record<string, unknown> | undefined): Promise<void> {
    const orderId = String(order?.orderId ?? "");
    if (!orderId) return;
    const leg = await this.prisma.tradeJobLeg.findFirst({ where: { jobId, brokerOrderId: orderId } });
    if (!leg) return;
    const positionId = String(position?.positionId ?? "") || undefined;
    await this.prisma.tradeJobLeg.update({ where: { id: leg.id }, data: {
      status: "FILLED", brokerPositionId: positionId, filledVolume: leg.plannedVolume,
      entryPrice: deal?.executionPrice !== undefined ? Number(deal.executionPrice) : leg.entryPrice,
    }});
    if (leg.purpose === "INITIAL") {
      await this.prisma.tradeJob.updateMany({ where: { id: jobId, activeDirection: null }, data: {
        activeDirection: leg.direction,
        newsReversalState: leg.direction === "BUY" ? "INITIAL_BUY_ACTIVE" : "INITIAL_SELL_ACTIVE",
      }});
    } else {
      await this.prisma.tradeJob.updateMany({ where: { id: jobId, reversalCount: 0 }, data: {
        reversalCount: 1, activeDirection: leg.direction, newsReversalState: "REVERSAL_ACTIVE",
      }});
    }
  }

  private async recordNewsReversalClose(jobId: string, _order: Record<string, unknown> | undefined,
    deal: Record<string, unknown> | undefined, position: Record<string, unknown> | undefined): Promise<void> {
    const positionId = String(position?.positionId ?? "");
    if (!positionId) return;
    const leg = await this.prisma.tradeJobLeg.findFirst({ where: { jobId, brokerPositionId: positionId } });
    if (!leg || leg.status !== "FILLED") return;
    const price = Number(deal?.executionPrice ?? 0);
    const tp = Number(leg.takeProfitPrice ?? 0); const sl = Number(leg.stopLossPrice ?? 0);
    const tpDistance = tp ? Math.abs(price - tp) : Number.POSITIVE_INFINITY;
    const slDistance = sl ? Math.abs(price - sl) : Number.POSITIVE_INFINITY;
    const status = tpDistance <= slDistance ? "CLOSED_TP" : "CLOSED_SL";
    await this.prisma.tradeJobLeg.update({ where: { id: leg.id }, data: { status, closedAt: new Date() } });
  }

  private scheduleProtectionSync(jobId: string): void {
    const runtime = this.runtimes.get(jobId); if (!runtime) return;
    if (runtime.protectionSync) clearTimeout(runtime.protectionSync);
    runtime.protectionSync = setTimeout(() => void this.syncNewsReversalProtection(jobId), 500);
  }

  private async syncNewsReversalProtection(jobId: string): Promise<void> {
    if (this.managingJobs.has(jobId)) return;
    const runtime = this.runtimes.get(jobId); if (!runtime || runtime.executionMode !== "NEWS_REVERSAL") return;
    this.managingJobs.add(jobId);
    try {
      const job = await this.prisma.tradeJob.findUnique({ where: { id: jobId }, include: { legs: true } });
      if (!job || !job.activeDirection || job.newsReversalState === "COMPLETED") return;
      if (job.reversalCount > 0 || job.newsReversalState === "REVERSAL_ACTIVE") {
        await this.cancelLegs(runtime, job.legs.filter((leg) => leg.status === "SUBMITTED" && leg.purpose === "INITIAL"));
        const staleInitial = job.legs.filter((leg) => leg.status === "FILLED" && leg.direction !== job.activeDirection && leg.brokerPositionId);
        for (const leg of staleInitial) await this.closeLegPosition(runtime, leg);
        return;
      }
      await this.ensureRuntimeSymbol(runtime);
      const active = job.legs.filter((leg) => leg.direction === job.activeDirection && leg.purpose === "INITIAL" && leg.status === "FILLED");
      const closedTp = job.legs.filter((leg) => leg.direction === job.activeDirection && leg.purpose === "INITIAL" && leg.status === "CLOSED_TP").length;
      if (closedTp >= 3 || active.length === 0) {
        if (closedTp >= 3) await this.completeNewsReversal(jobId, runtime, "All three take-profit targets reached");
        return;
      }
      const opposite = job.activeDirection === "BUY" ? "SELL" : "BUY";
      // Once the first side is known, no initial leg may remain pending: a late
      // same-side or opposite fill would change exposure after protection sizing.
      await this.cancelLegs(runtime, job.legs.filter((leg) => leg.status === "SUBMITTED"));
      const accidentalOpposite = job.legs.filter((leg) => leg.purpose === "INITIAL" && leg.status === "FILLED" &&
        leg.direction !== job.activeDirection && leg.brokerPositionId);
      for (const leg of accidentalOpposite) await this.closeLegPosition(runtime, leg);

      const gapPoints = job.reversalGapPoints ?? 0;
      if (gapPoints < 1) throw new Error("NEWS REVERSAL fixed gap is missing");
      const reference = fixedReversalPrice({ direction: job.activeDirection, entryPrice: Number(active[0].entryPrice),
        stopDistance: job.stopLossPoints * runtime.point!, reversalGap: gapPoints * runtime.point! });
      const reversalEntryPrice = this.round(reference, runtime.digits!);
      const reverseTargets = reversalTargetsAfter(closedTp, [job.takeProfitPoints, job.takeProfit2Points!, job.takeProfit3Points!]);
      const sortedActive = [...active].sort((a, b) => a.targetNumber - b.targetNumber);
      for (let index = 0; index < sortedActive.length; index += 1) {
        const source = sortedActive[index]; const targetPoints = reverseTargets[Math.min(index, reverseTargets.length - 1)];
        const apiVolume = Math.round(Number(source.plannedVolume) * runtime.lotSize!);
        const slPrice = this.round(opposite === "BUY" ? reversalEntryPrice - job.stopLossPoints * runtime.point! : reversalEntryPrice + job.stopLossPoints * runtime.point!, runtime.digits!);
        const tpPrice = this.round(opposite === "BUY" ? reversalEntryPrice + targetPoints * runtime.point! : reversalEntryPrice - targetPoints * runtime.point!, runtime.digits!);
        const leg = await this.prisma.tradeJobLeg.upsert({ where: { jobId_purpose_direction_targetNumber_revision: {
          jobId, purpose: "REVERSAL", direction: opposite, targetNumber: index + 1, revision: closedTp,
        } }, update: { plannedVolume: source.plannedVolume, entryPrice: reversalEntryPrice, stopLossPrice: slPrice,
          takeProfitPrice: tpPrice, status: "PLANNED", brokerOrderId: null, brokerPositionId: null },
        create: { jobId, purpose: "REVERSAL", direction: opposite, targetNumber: index + 1, revision: closedTp,
          legNumber: index + 1, plannedVolume: source.plannedVolume, entryPrice: reversalEntryPrice,
          stopLossPrice: slPrice, takeProfitPrice: tpPrice } });
        const orderId = await this.place(jobId, runtime.client, {
          ctidTraderAccountId: this.safeId(runtime.ctid, "ctidTraderAccountId"), symbolId: this.safeId(runtime.symbolId, "symbolId"),
          volume: apiVolume, orderType: 3, tradeSide: opposite === "BUY" ? 1 : 2, stopPrice: reversalEntryPrice,
          relativeStopLoss: Math.round(job.stopLossPoints * runtime.point! * 100_000),
          relativeTakeProfit: Math.round(targetPoints * runtime.point! * 100_000), timeInForce: 1,
          expirationTimestamp: job.managementExpiresAt?.getTime(),
          label: this.label(jobId, `NR-R${closedTp}-${opposite === "BUY" ? "B" : "S"}${index + 1}`),
          clientOrderId: `${jobId.slice(0, 20)}R${closedTp}${opposite === "BUY" ? "B" : "S"}${index + 1}`,
        });
        runtime.orderIds.push(orderId);
        await this.prisma.tradeJobLeg.update({ where: { id: leg.id }, data: { brokerOrderId: orderId, status: "SUBMITTED" } });
      }
      await this.prisma.tradeJob.update({ where: { id: jobId }, data: {
        newsReversalState: closedTp === 0
          ? (job.activeDirection === "BUY" ? "INITIAL_BUY_ACTIVE" : "INITIAL_SELL_ACTIVE")
          : closedTp === 1 ? "TP1_PROTECTED" : "TP2_PROTECTED",
        status: "MANAGED",
      }});
      await this.report(jobId, `ctrader:${jobId}:protection:${closedTp}:${Date.now()}`, "ACCEPTED",
        closedTp === 0
          ? `Fixed reversal placed ${gapPoints} points beyond initial SL at ${reversalEntryPrice}`
          : `TP${closedTp} reached; reversal volume reduced without moving fixed entry ${reversalEntryPrice}`);
    } catch (error) {
      await this.report(jobId, `ctrader:${jobId}:protection-error:${Date.now()}`, "ERROR",
        `NEWS REVERSAL protection failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally { this.managingJobs.delete(jobId); }
  }

  private async cancelLegs(runtime: Runtime, legs: Array<{ id: string; brokerOrderId: string | null }>): Promise<void> {
    for (const leg of legs) {
      if (!leg.brokerOrderId) continue;
      try {
        await this.cancel(runtime, leg.brokerOrderId);
        await this.prisma.tradeJobLeg.update({ where: { id: leg.id }, data: { status: "CANCELLED" } });
        runtime.orderIds = runtime.orderIds.filter((id) => id !== leg.brokerOrderId);
      } catch { /* It may already have filled; the execution event will reconcile it. */ }
    }
  }

  private async closeLegPosition(runtime: Runtime, leg: { id: string; plannedVolume: Prisma.Decimal; brokerPositionId: string | null }): Promise<void> {
    if (!leg.brokerPositionId) return;
    await this.ensureRuntimeSymbol(runtime);
    const volume = Math.round(Number(leg.plannedVolume) * runtime.lotSize!);
    await runtime.client.request(2111, { ctidTraderAccountId: this.safeId(runtime.ctid, "ctidTraderAccountId"),
      positionId: this.safeId(leg.brokerPositionId, "positionId"), volume }, [2126]);
    await this.prisma.tradeJobLeg.update({ where: { id: leg.id }, data: { status: "CLOSED_MANUAL", closedAt: new Date() } });
  }

  private async ensureRuntimeSymbol(runtime: Runtime): Promise<void> {
    if (runtime.point && runtime.digits !== undefined && runtime.lotSize) return;
    const response = await runtime.client.request(2116, { ctidTraderAccountId: this.safeId(runtime.ctid, "ctidTraderAccountId"),
      symbolId: [this.safeId(runtime.symbolId, "symbolId")] }, [2117]);
    const symbol = ((response.payload?.symbol ?? []) as Array<Record<string, unknown>>)[0];
    if (!symbol) throw new Error("Symbol details unavailable during recovery");
    runtime.digits = Number(symbol.digits ?? 2); runtime.point = 10 ** -runtime.digits; runtime.lotSize = Number(symbol.lotSize ?? 0);
    if (!runtime.lotSize) throw new Error("Invalid symbol lot size");
  }

  private async reconcileNewsReversal(jobId: string, _runtime: Runtime,
    orders: Array<Record<string, unknown>>, positions: Array<Record<string, unknown>>): Promise<void> {
    for (const order of orders) {
      const orderId = String(order.orderId ?? ""); const label = String((order.tradeData as Record<string, unknown> | undefined)?.label ?? "");
      if (!orderId || !label) continue;
      await this.prisma.tradeJobLeg.updateMany({ where: { jobId, brokerOrderId: orderId }, data: { status: "SUBMITTED" } });
    }
    for (const position of positions) {
      const positionId = String(position.positionId ?? "");
      const orderId = String(position.orderId ?? (position.tradeData as Record<string, unknown> | undefined)?.orderId ?? "");
      if (!positionId) continue;
      await this.prisma.tradeJobLeg.updateMany({ where: { jobId, OR: [
        { brokerPositionId: positionId }, ...(orderId ? [{ brokerOrderId: orderId }] : []),
      ] }, data: { brokerPositionId: positionId, status: "FILLED" } });
    }
    this.scheduleProtectionSync(jobId);
  }

  private async completeNewsReversal(jobId: string, runtime: Runtime, message: string): Promise<void> {
    const pending = await this.prisma.tradeJobLeg.findMany({ where: { jobId, status: "SUBMITTED" } });
    await this.cancelLegs(runtime, pending);
    await this.prisma.tradeJob.update({ where: { id: jobId }, data: {
      status: "CLOSED", closedAt: new Date(), newsReversalState: "COMPLETED", leaseOwner: null, leaseExpiresAt: null,
    }});
    await this.report(jobId, `ctrader:${jobId}:completed:${Date.now()}`, "CLOSED", message);
    this.finish(jobId);
  }

  private async expireManagement(jobId: string): Promise<void> {
    const runtime = this.runtimes.get(jobId); if (!runtime) return;
    const legs = await this.prisma.tradeJobLeg.findMany({ where: { jobId } });
    await this.cancelLegs(runtime, legs.filter((leg) => leg.status === "SUBMITTED"));
    for (const leg of legs.filter((item) => item.status === "FILLED" && item.brokerPositionId)) {
      const volume = Math.round(Number(leg.plannedVolume) * (runtime.lotSize ?? 0));
      if (!volume) continue;
      await runtime.client.request(2111, { ctidTraderAccountId: this.safeId(runtime.ctid, "ctidTraderAccountId"),
        positionId: this.safeId(leg.brokerPositionId!, "positionId"), volume }, [2126]).catch(() => undefined);
    }
    await this.completeNewsReversal(jobId, runtime, "Maximum NEWS REVERSAL position lifetime reached");
  }

  private async expire(jobId: string): Promise<void> {
    const runtime = this.runtimes.get(jobId); if (!runtime) return;
    if (runtime.executionMode === "NEWS_REVERSAL" && runtime.filled) {
      const initialPending = await this.prisma.tradeJobLeg.findMany({ where: { jobId, purpose: "INITIAL", status: "SUBMITTED" } });
      await this.cancelLegs(runtime, initialPending);
      return;
    }
    for (const orderId of runtime.orderIds) await this.cancel(runtime, orderId).catch(() => undefined);
    if (!runtime.filled) {
      await this.prisma.tradeJob.updateMany({ where: { id: jobId, status: { in: ["ARMED", "SUBMITTED"] } }, data: { status: "EXPIRED", cancelledAt: new Date() } });
      await this.report(jobId, `ctrader:${jobId}:expired`, "CANCELLED", "cTrader pending window expired"); this.finish(jobId);
    } else if (runtime.openPositions.size === 0) {
      await this.prisma.tradeJob.updateMany({ where: { id: jobId, status: { in: ["FILLED", "PARTIALLY_FILLED", "MANAGED"] } }, data: { status: "CLOSED", closedAt: new Date() } });
      this.finish(jobId);
    }
  }

  private async reject(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "cTrader execution failed";
    const runtime = this.runtimes.get(jobId);
    if (runtime) for (const orderId of runtime.orderIds) await this.cancel(runtime, orderId).catch(() => undefined);
    await this.prisma.tradeJob.updateMany({ where: { id: jobId, status: { in: ["ARMED", "SUBMITTED"] } }, data: { status: "REJECTED" } });
    await this.report(jobId, `ctrader:${jobId}:rejected:${Date.now()}`, "REJECTED", message); this.finish(jobId);
  }

  private async report(jobId: string, reportKey: string, phase: ExecutionPhase, message: string, extra: ReportExtra = {}): Promise<void> {
    await this.prisma.executionReport.upsert({ where: { reportKey }, update: {}, create: { jobId, reportKey, executionSource: "CTRADER_OPEN_API", phase,
      occurredAt: new Date(), message, ...extra, raw: { worker: "ctrader-json-v1" } } });
  }

  private waitForSpot(client: CTraderJsonClient, ctid: string, symbolId: string): Promise<{ bid: number; ask: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("cTrader spot quote timed out")); }, 10_000);
      let bid: number | undefined; let ask: number | undefined;
      const unsubscribe = client.onMessage((message) => {
        if (message.payloadType !== 2131 || String(message.payload?.ctidTraderAccountId) !== ctid || String(message.payload?.symbolId) !== symbolId) return;
        if (message.payload?.bid !== undefined) bid = Number(message.payload.bid) / 100_000;
        if (message.payload?.ask !== undefined) ask = Number(message.payload.ask) / 100_000;
        if (bid !== undefined && ask !== undefined) { clearTimeout(timer); unsubscribe(); resolve({ bid, ask }); }
      });
    });
  }

  private finish(jobId: string): void { const runtime = this.runtimes.get(jobId); if (runtime) this.closeRuntime(runtime); this.runtimes.delete(jobId); }
  private closeRuntime(runtime: Runtime): void {
    if (runtime.expiry) clearTimeout(runtime.expiry);
    if (runtime.execute) clearTimeout(runtime.execute);
    if (runtime.management) clearTimeout(runtime.management);
    if (runtime.protectionSync) clearTimeout(runtime.protectionSync);
    runtime.client.close();
  }
  private label(jobId: string, side: string): string { return `tg-${jobId.slice(0, 12)}-${side}`; }
  private round(value: number, digits: number): number { return Number(value.toFixed(digits)); }
  private async jobExpiry(jobId: string): Promise<number> {
    const job = await this.prisma.tradeJob.findUnique({ where: { id: jobId }, select: { expiresAt: true } });
    return job?.expiresAt.getTime() ?? Date.now();
  }
  private safeId(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid or unsafe cTrader ${name}`);
    return parsed;
  }

  private async renewLeases(): Promise<void> {
    const ids = [...new Set([...this.runtimes.keys(), ...this.startingJobs])];
    if (ids.length === 0) return;
    await this.prisma.tradeJob.updateMany({
      where: { id: { in: ids }, leaseOwner: this.workerId, status: { in: ["ARMED", "SUBMITTED", "FILLED", "PARTIALLY_FILLED", "MANAGED"] } },
      data: { leaseExpiresAt: new Date(Date.now() + this.leaseMs) },
    }).catch((error) => this.logger.error("Unable to renew cTrader execution leases", error));
  }

  private async enforceKillSwitch(): Promise<void> {
    const safety = await this.safety.status().catch(() => null);
    if (!safety?.halted) return;
    for (const [jobId, runtime] of this.runtimes) {
      if (runtime.haltHandled) continue;
      runtime.haltHandled = true;
      if (runtime.execute) { clearTimeout(runtime.execute); runtime.execute = undefined; }
      for (const orderId of runtime.orderIds) await this.cancel(runtime, orderId).catch(() => undefined);
      runtime.orderIds = [];
      await this.report(jobId, `ctrader:${jobId}:kill-switch`, "CANCELLED",
        runtime.filled ? "Kill switch cancelled remaining entries; protected open positions were left open" : "Kill switch cancelled pending execution");
      if (!runtime.filled) {
        await this.prisma.tradeJob.updateMany({
          where: { id: jobId, status: { in: ["ARMED", "SUBMITTED"] } },
          data: { status: "CANCELLED", cancelledAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
        });
        this.finish(jobId);
      }
    }
  }

  private async enforceUserRequests(): Promise<void> {
    if (this.runtimes.size === 0) return;
    const jobs = await this.prisma.tradeJob.findMany({ where: { id: { in: [...this.runtimes.keys()] },
      OR: [{ cancelRequestedAt: { not: null } }, { closeRequestedAt: { not: null } }] },
      select: { id: true, cancelRequestedAt: true, closeRequestedAt: true } });
    for (const job of jobs) {
      const runtime = this.runtimes.get(job.id); if (!runtime) continue;
      if (job.closeRequestedAt) {
        for (const orderId of runtime.orderIds) await this.cancel(runtime, orderId).catch(() => undefined);
        runtime.orderIds = [];
        const response = await runtime.client.request(2124, { ctidTraderAccountId: this.safeId(runtime.ctid, "ctidTraderAccountId"),
          returnProtectionOrders: false }, [2125]).catch(() => null);
        const prefix = `tg-${job.id.slice(0, 12)}`;
        const positions = ((response?.payload?.position ?? []) as Array<Record<string, unknown>>).filter((position) =>
          String((position.tradeData as Record<string, unknown> | undefined)?.label ?? "").startsWith(prefix));
        for (const position of positions) {
          const tradeData = position.tradeData as Record<string, unknown> | undefined;
          const volume = Number(tradeData?.volume ?? position.volume ?? 0);
          if (!volume) continue;
          await runtime.client.request(2111, { ctidTraderAccountId: this.safeId(runtime.ctid, "ctidTraderAccountId"),
            positionId: this.safeId(String(position.positionId), "positionId"), volume }, [2126]).catch(() => undefined);
        }
        await this.prisma.tradeJob.update({ where: { id: job.id }, data: { status: "CLOSED", closedAt: new Date(),
          closeRequestedAt: null, cancelRequestedAt: null, leaseOwner: null, leaseExpiresAt: null,
          newsReversalState: runtime.executionMode === "NEWS_REVERSAL" ? "COMPLETED" : undefined } });
        await this.report(job.id, `ctrader:${job.id}:user-close`, "CLOSED", "User closed positions and cancelled pending orders");
        this.finish(job.id);
        continue;
      }
      if (job.cancelRequestedAt) {
        for (const orderId of runtime.orderIds) await this.cancel(runtime, orderId).catch(() => undefined);
        runtime.orderIds = [];
        await this.prisma.tradeJob.update({ where: { id: job.id }, data: runtime.openPositions.size === 0
          ? { status: "CANCELLED", cancelledAt: new Date(), cancelRequestedAt: null, leaseOwner: null, leaseExpiresAt: null }
          : { cancelRequestedAt: null } });
        await this.report(job.id, `ctrader:${job.id}:user-cancel:${Date.now()}`, "CANCELLED",
          runtime.openPositions.size === 0 ? "User cancelled pending job" : "User cancelled pending orders; protected positions remain open");
        if (runtime.openPositions.size === 0) this.finish(job.id);
      }
    }
  }

  private async handleDisconnect(jobId: string, error: Error): Promise<void> {
    const runtime = this.runtimes.get(jobId);
    if (!runtime) return;
    if (runtime.expiry) clearTimeout(runtime.expiry);
    if (runtime.execute) clearTimeout(runtime.execute);
    this.runtimes.delete(jobId);
    await this.report(jobId, `ctrader:${jobId}:disconnect:${Date.now()}`, "ERROR", `${error.message}; automatic recovery scheduled`);
    await this.prisma.tradeJob.updateMany({
      where: { id: jobId, leaseOwner: this.workerId, status: { in: ["ARMED", "SUBMITTED", "FILLED", "PARTIALLY_FILLED", "MANAGED"] } },
      data: { leaseOwner: null, leaseExpiresAt: new Date(Date.now() + 5_000) },
    });
  }

  private async handleStartFailure(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "cTrader execution failed";
    const transient = /WebSocket|timed out|TIMEOUT_ERROR|CANT_ROUTE_REQUEST|connection/i.test(message);
    if (!transient) {
      await this.reject(jobId, error);
      return;
    }
    const runtime = this.runtimes.get(jobId);
    if (runtime) {
      if (runtime.expiry) clearTimeout(runtime.expiry);
      if (runtime.execute) clearTimeout(runtime.execute);
      runtime.client.close();
      this.runtimes.delete(jobId);
    }
    await this.report(jobId, `ctrader:${jobId}:retry:${Date.now()}`, "ERROR", `${message}; automatic recovery scheduled`);
    await this.prisma.tradeJob.updateMany({
      where: { id: jobId, leaseOwner: this.workerId, status: { in: ["ARMED", "SUBMITTED", "FILLED", "PARTIALLY_FILLED", "MANAGED"] } },
      data: { leaseOwner: null, leaseExpiresAt: new Date(Date.now() + 5_000) },
    });
  }

  private plannedPositions(job: Pick<JobWithAccount, "executionMode" | "multiTradesPerSide">): number {
    if (job.executionMode === "MULTI") return 2 * (job.multiTradesPerSide ?? 2);
    if (job.executionMode === "NEWS_REVERSAL") return 6;
    return 1;
  }

  private async assertPositionLimit(job: JobWithAccount, accountPositions: Array<Record<string, unknown>>): Promise<void> {
    const unmanagedOnAccount = accountPositions.filter((position) =>
      !String((position.tradeData as Record<string, unknown> | undefined)?.label ?? "").startsWith("tg-"),
    ).length;
    const active = await this.prisma.tradeJob.findMany({
      where: { userId: job.userId, executionVenue: "CTRADER", id: { not: job.id },
        status: { in: ["ARMED", "SUBMITTED", "FILLED", "PARTIALLY_FILLED", "MANAGED"] } },
      select: { executionMode: true, multiTradesPerSide: true },
    });
    const projected = unmanagedOnAccount + this.plannedPositions(job) + active.reduce((sum, item) => sum + this.plannedPositions(item), 0);
    if (projected > this.maxOpenPositionsPerUser)
      throw new Error(`POSITION_LIMIT: projected ${projected} positions exceeds user limit ${this.maxOpenPositionsPerUser}`);
  }

  private assertEstimatedRisk(job: JobWithAccount, trader: Record<string, unknown>, symbol: Record<string, unknown>, volume: number, point: number): void {
    // Exact P/L conversion needs an asset conversion chain. Enforce the monetary
    // risk cap when quote and deposit currencies already match; broker margin
    // preflight remains mandatory for all other currency combinations.
    if (String(symbol.quoteAssetId) !== String(trader.depositAssetId)) return;
    const moneyDigits = Number(trader.moneyDigits ?? 2);
    const balance = Number(trader.balance ?? 0) / 10 ** moneyDigits;
    const units = volume / 100;
    let stopDistanceSum = job.stopLossPoints * point;
    if (job.executionMode === "MULTI") {
      const count = job.multiTradesPerSide ?? 2;
      stopDistanceSum = 2 * (job.stopLossPoints + Math.max(0, count - 1) * (job.multiNextSlPoints ?? job.stopLossPoints)) * point;
    }
    if (job.executionMode === "NEWS_REVERSAL")
      stopDistanceSum = job.stopLossPoints * point * (job.volumeAllocationMode === "FULL_EACH" ? 3 : 1);
    const estimatedLoss = units * stopDistanceSum;
    const riskPercent = balance > 0 ? estimatedLoss / balance * 100 : Number.POSITIVE_INFINITY;
    if (riskPercent > this.maxRiskPercent + 1e-9)
      throw new Error(`RISK_LIMIT: estimated ${riskPercent.toFixed(3)}% exceeds ${this.maxRiskPercent}%`);
  }

  private async assertMargin(client: CTraderJsonClient, ctid: number, symbolId: number, volume: number,
    job: JobWithAccount, trader: Record<string, unknown>, positions: Array<Record<string, unknown>>): Promise<void> {
    const response = await client.request(2139, { ctidTraderAccountId: ctid, symbolId, volume: [volume] }, [2140]);
    const margin = ((response.payload?.margin ?? []) as Array<Record<string, unknown>>).find((item) => Number(item.volume) === volume);
    if (!margin) throw new Error("MARGIN_PREFLIGHT: cTrader returned no margin estimate");
    const marginDigits = Number(response.payload?.moneyDigits ?? trader.moneyDigits ?? 2);
    const divisor = 10 ** marginDigits;
    const buy = Number(margin.buyMargin ?? 0) / divisor;
    const sell = Number(margin.sellMargin ?? 0) / divisor;
    let required = job.direction === "BUY" ? buy : sell;
    if (job.executionMode === "STRADDLE") required = Math.max(buy, sell);
    if (job.executionMode === "MULTI") required = (buy + sell) * (job.multiTradesPerSide ?? 2);
    if (job.executionMode === "NEWS_REVERSAL")
      required = Math.max(buy, sell) * (job.volumeAllocationMode === "FULL_EACH" ? 3 : 1);
    const balance = Number(trader.balance ?? 0) / 10 ** Number(trader.moneyDigits ?? marginDigits);
    const used = positions.reduce((sum, position) => sum + Number(position.usedMargin ?? 0) / divisor, 0);
    const conservativeFree = Math.max(0, balance - used);
    if (required * this.marginBufferMultiplier > conservativeFree)
      throw new Error(`MARGIN_PREFLIGHT: required ${required.toFixed(2)} plus safety buffer exceeds estimated free ${conservativeFree.toFixed(2)}`);
  }
}
