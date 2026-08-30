import { ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SafetyService {
  private readonly environmentHalt: boolean;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.environmentHalt = config.get<boolean>("TRADING_KILL_SWITCH") ?? false;
  }

  async status() {
    const control = await this.prisma.systemControl.upsert({
      where: { id: "global" },
      create: { id: "global" },
      update: {},
    });
    return {
      halted: this.environmentHalt || control.tradingHalted,
      environmentHalt: this.environmentHalt,
      databaseHalt: control.tradingHalted,
      reason: this.environmentHalt ? "TRADING_KILL_SWITCH=true" : control.reason,
      updatedAt: control.updatedAt,
    };
  }

  async assertTradingOpen(): Promise<void> {
    const status = await this.status();
    if (status.halted) throw new ForbiddenException(`Trading is halted${status.reason ? `: ${status.reason}` : ""}`);
  }

  async halt(reason = "Emergency stop activated by administrator") {
    return this.prisma.systemControl.upsert({
      where: { id: "global" },
      create: { id: "global", tradingHalted: true, reason },
      update: { tradingHalted: true, reason },
    });
  }

  async resume() {
    return this.prisma.systemControl.upsert({
      where: { id: "global" },
      create: { id: "global", tradingHalted: false },
      update: { tradingHalted: false, reason: null },
    });
  }
}
