import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { RiskMode } from "../generated/prisma/client";
import type { VolumeAllocationMode } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface TelegramUserInput {
  telegramId: bigint;
  username?: string;
  firstName?: string;
  languageCode?: string;
}

@Injectable()
export class UsersService {
  private readonly maxRiskPercent: number;
  private readonly maxFixedLot: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.maxRiskPercent = config.getOrThrow<number>("MAX_RISK_PERCENT");
    this.maxFixedLot = config.getOrThrow<number>("MAX_FIXED_LOT");
  }

  upsertTelegramUser(input: TelegramUserInput) {
    return this.prisma.user.upsert({
      where: { telegramId: input.telegramId },
      create: {
        telegramId: input.telegramId,
        telegramUsername: input.username,
        firstName: input.firstName,
        languageCode: input.languageCode ?? "ru",
        settings: { create: {} },
      },
      update: {
        telegramUsername: input.username,
        firstName: input.firstName,
        languageCode: input.languageCode ?? undefined,
      },
      include: { settings: true },
    });
  }

  findByTelegramId(telegramId: bigint) {
    return this.prisma.user.findUnique({
      where: { telegramId },
      include: {
        settings: true,
        agents: { orderBy: { createdAt: "desc" } },
        accounts: { orderBy: { createdAt: "desc" } },
      },
    });
  }

  async updateTradingDefault(
    telegramId: bigint,
    update:
      | { field: "defaultFixedLot"; value: number }
      | { field: "defaultRiskPercent"; value: number }
      | { field: "defaultArmSeconds"; value: number }
      | { field: "defaultRiskMode"; value: RiskMode },
  ) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");

    if (update.field === "defaultFixedLot" && (update.value < 0.0001 || update.value > this.maxFixedLot)) {
      throw new BadRequestException(`Lot must be between 0.0001 and ${this.maxFixedLot}`);
    }
    if (
      update.field === "defaultRiskPercent" &&
      (update.value < 0.01 || update.value > this.maxRiskPercent)
    ) {
      throw new BadRequestException(`Risk must be between 0.01% and ${this.maxRiskPercent}%`);
    }
    if (
      update.field === "defaultArmSeconds" &&
      (!Number.isInteger(update.value) || update.value < 3 || update.value > 60)
    ) {
      throw new BadRequestException("Arm time must be an integer between 3 and 60 seconds");
    }

    return this.prisma.userSettings.update({
      where: { userId: user.id },
      data: { [update.field]: update.value },
    });
  }

  async updateMultiTemplate(telegramId: bigint, values: {
    tradesPerSide: number; firstEntryPips: number; firstSlPips: number; firstTpPips: number;
    nextStepPips: number; nextSlPips: number; nextTpPips: number; expirySeconds: number;
  }) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    if (!Number.isInteger(values.tradesPerSide) || values.tradesPerSide < 2 || values.tradesPerSide > 5)
      throw new BadRequestException("Trades per side must be 2-5");
    for (const value of [values.firstEntryPips, values.firstSlPips, values.firstTpPips, values.nextStepPips, values.nextSlPips, values.nextTpPips])
      if (!Number.isInteger(value) || value < 1 || value > 100_000) throw new BadRequestException("Pips must be integers from 1 to 100000");
    if (!Number.isInteger(values.expirySeconds) || values.expirySeconds < 1 || values.expirySeconds > 300)
      throw new BadRequestException("Expiry must be 1-300 seconds");
    return this.prisma.userSettings.update({ where: { userId: user.id }, data: {
      multiTradesPerSide: values.tradesPerSide, multiFirstEntryPips: values.firstEntryPips,
      multiFirstSlPips: values.firstSlPips, multiFirstTpPips: values.firstTpPips,
      multiNextStepPips: values.nextStepPips, multiNextSlPips: values.nextSlPips,
      multiNextTpPips: values.nextTpPips, multiExpirySeconds: values.expirySeconds,
    }});
  }

  async updateNewsReversalTemplate(telegramId: bigint, values: {
    volumeMode: VolumeAllocationMode; entryPips: number; slPips: number;
    tp1Pips: number; tp2Pips: number; tp3Pips: number;
    reversalGapPips: number;
    pendingExpirySeconds: number; managementSeconds: number;
  }) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    const pips = [values.entryPips, values.slPips, values.tp1Pips, values.tp2Pips, values.tp3Pips,
      values.reversalGapPips];
    if (pips.some((value) => !Number.isInteger(value) || value < 1 || value > 100_000))
      throw new BadRequestException("Pips must be integers from 1 to 100000");
    if (!(values.tp1Pips < values.tp2Pips && values.tp2Pips < values.tp3Pips))
      throw new BadRequestException("TP1, TP2 and TP3 must be strictly increasing");
    if (!Number.isInteger(values.pendingExpirySeconds) || values.pendingExpirySeconds < 1 || values.pendingExpirySeconds > 300)
      throw new BadRequestException("Pending expiry must be 1-300 seconds");
    if (!Number.isInteger(values.managementSeconds) || values.managementSeconds < 30 || values.managementSeconds > 3600)
      throw new BadRequestException("Management time must be 30-3600 seconds");
    return this.prisma.userSettings.update({ where: { userId: user.id }, data: {
      reversalVolumeMode: values.volumeMode, reversalEntryPips: values.entryPips,
      reversalSlPips: values.slPips, reversalTp1Pips: values.tp1Pips,
      reversalTp2Pips: values.tp2Pips, reversalTp3Pips: values.tp3Pips,
      reversalGapPips: values.reversalGapPips,
      reversalPendingExpirySeconds: values.pendingExpirySeconds,
      reversalManagementSeconds: values.managementSeconds,
    }});
  }

  async setRealTradingEnabled(telegramId: bigint, enabled: boolean) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.prisma.userSettings.update({
      where: { userId: user.id },
      data: { realTradingEnabled: enabled },
    });
  }

  async setRiskLimitEnabled(telegramId: bigint, enabled: boolean) {
    const user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) throw new NotFoundException("Telegram user not found");
    return this.prisma.userSettings.update({
      where: { userId: user.id },
      data: { riskLimitEnabled: enabled },
    });
  }
}
