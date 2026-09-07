import { ForbiddenException, Injectable, NotFoundException, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ExecutionMode } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PLAN_PRESETS, type PlanCode } from "./subscription-presets";

@Injectable()
export class SubscriptionsService implements OnModuleInit {
  private readonly enforced: boolean;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.enforced = config.getOrThrow<boolean>("SUBSCRIPTIONS_ENFORCED");
  }

  async onModuleInit(): Promise<void> {
    await this.ensurePlans();
  }

  async ensurePlans(): Promise<void> {
    for (const [code, preset] of Object.entries(PLAN_PRESETS) as Array<[PlanCode, typeof PLAN_PRESETS[PlanCode]]>) {
      await this.prisma.plan.upsert({
        where: { code },
        create: { code, ...preset },
        update: { ...preset },
      });
    }
  }

  async ensureTrial(userId: string) {
    const existing = await this.prisma.subscription.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
    if (existing) return existing;
    return this.grantToUser(userId, "TRIAL", PLAN_PRESETS.TRIAL.durationDays, "SYSTEM", "signup");
  }

  async grantByTelegramId(telegramId: string, planCode: PlanCode, days: number | undefined, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.grantToUser(user.id, planCode, days ?? PLAN_PRESETS[planCode].durationDays, "ADMIN", actorId);
  }

  async grantToUser(userId: string, planCode: PlanCode, days: number, actorType: string, actorId: string) {
    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });
    if (!plan) throw new NotFoundException(`Plan ${planCode} not found`);
    const now = new Date();
    const currentPeriodEnd = new Date(now.getTime() + days * 86_400_000);
    return this.prisma.$transaction(async (tx) => {
      await tx.subscription.updateMany({
        where: { userId, status: { in: ["TRIAL", "ACTIVE", "PAST_DUE"] } },
        data: { status: "CANCELED", canceledAt: now },
      });
      const subscription = await tx.subscription.create({
        data: {
          userId,
          planId: plan.id,
          status: planCode === "TRIAL" ? "TRIAL" : "ACTIVE",
          startsAt: now,
          currentPeriodEnd,
          entitlement: { create: {
            marketEnabled: plan.marketEnabled,
            ocoEnabled: plan.ocoEnabled,
            multiEnabled: plan.multiEnabled,
            newsReversalEnabled: plan.newsReversalEnabled,
            liveTradingEnabled: plan.liveTradingEnabled,
            maxAccounts: plan.maxAccounts,
            maxLot: plan.maxLot,
          } },
        },
        include: { plan: true, entitlement: true },
      });
      await tx.subscriptionAuditLog.create({ data: {
        userId, subscriptionId: subscription.id, actorType, actorId,
        action: "SUBSCRIPTION_GRANTED", metadata: { planCode, days, currentPeriodEnd: currentPeriodEnd.toISOString() },
      } });
      return subscription;
    });
  }

  async suspendByTelegramId(telegramId: string, actorId: string) {
    const user = await this.prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
    if (!user) throw new NotFoundException("Telegram user not found");
    const active = await this.prisma.subscription.findFirst({
      where: { userId: user.id, status: { in: ["TRIAL", "ACTIVE", "PAST_DUE"] } }, orderBy: { createdAt: "desc" },
    });
    if (!active) throw new NotFoundException("Active subscription not found");
    await this.prisma.$transaction([
      this.prisma.subscription.update({ where: { id: active.id }, data: { status: "SUSPENDED" } }),
      this.prisma.subscriptionAuditLog.create({ data: { userId: user.id, subscriptionId: active.id,
        actorType: "ADMIN", actorId, action: "SUBSCRIPTION_SUSPENDED" } }),
    ]);
  }

  async currentForUser(userId: string) {
    const subscription = await this.prisma.subscription.findFirst({
      where: { userId, status: { in: ["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED"] } },
      include: { plan: true, entitlement: true }, orderBy: { createdAt: "desc" },
    });
    if (!subscription) return null;
    if (["TRIAL", "ACTIVE", "PAST_DUE"].includes(subscription.status) && subscription.currentPeriodEnd <= new Date()) {
      return this.prisma.subscription.update({ where: { id: subscription.id }, data: { status: "EXPIRED" },
        include: { plan: true, entitlement: true } });
    }
    return subscription;
  }

  async currentByTelegramId(telegramId: bigint) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.currentForUser(user.id);
  }

  async assertCanCreateJob(userId: string, mode: ExecutionMode, live: boolean, fixedLot?: number | null): Promise<void> {
    if (!this.enforced) return;
    const subscription = await this.currentForUser(userId);
    const entitlement = subscription?.entitlement;
    if (!subscription || !entitlement || !["TRIAL", "ACTIVE"].includes(subscription.status))
      throw new ForbiddenException("SUBSCRIPTION_REQUIRED: active subscription is required");
    const allowed = mode === "MARKET" ? entitlement.marketEnabled
      : mode === "STRADDLE" ? entitlement.ocoEnabled
      : mode === "MULTI" ? entitlement.multiEnabled
      : entitlement.newsReversalEnabled;
    if (!allowed) throw new ForbiddenException(`PLAN_LIMIT: ${mode} is not included in ${subscription.plan.code}`);
    if (live && !entitlement.liveTradingEnabled)
      throw new ForbiddenException(`PLAN_LIMIT: live trading is not included in ${subscription.plan.code}`);
    if (fixedLot != null && fixedLot > Number(entitlement.maxLot))
      throw new ForbiddenException(`PLAN_LIMIT: lot ${fixedLot} exceeds plan maximum ${entitlement.maxLot.toString()}`);
  }

  async assertCanPairAccount(userId: string, environment: "DEMO" | "LIVE"): Promise<void> {
    if (!this.enforced) return;
    const subscription = await this.currentForUser(userId);
    const entitlement = subscription?.entitlement;
    if (!subscription || !entitlement || !["TRIAL", "ACTIVE"].includes(subscription.status))
      throw new ForbiddenException("SUBSCRIPTION_REQUIRED: active subscription is required");
    if (environment === "LIVE" && !entitlement.liveTradingEnabled)
      throw new ForbiddenException("PLAN_LIMIT: live cBot accounts are not included in this plan");
    const count = await this.prisma.cbotInstance.count({ where: { userId, status: { not: "REVOKED" } } });
    if (count >= entitlement.maxAccounts)
      throw new ForbiddenException(`PLAN_LIMIT: maximum ${entitlement.maxAccounts} connected account(s)`);
  }

  listPlans() {
    return this.prisma.plan.findMany({ where: { active: true }, orderBy: { priceUsd: "asc" } });
  }

  listUsers(limit = 100) {
    return this.prisma.user.findMany({
      orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 500),
      select: {
        id: true, telegramId: true, telegramUsername: true, firstName: true, status: true,
        subscriptions: { orderBy: { createdAt: "desc" }, take: 1,
          include: { plan: true, entitlement: true } },
        cbotInstances: { where: { status: { not: "REVOKED" } },
          select: { id: true, accountNumber: true, broker: true, environment: true, status: true, lastSeenAt: true } },
      },
    });
  }

  isEnforced(): boolean { return this.enforced; }
}
