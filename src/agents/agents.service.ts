import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Agent } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { HeartbeatDto } from "./dto/heartbeat.dto";

@Injectable()
export class AgentsService {
  private readonly allowRealTrading: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.allowRealTrading = config.getOrThrow<boolean>("ALLOW_REAL_TRADING");
  }

  async heartbeat(agent: Agent, dto: HeartbeatDto, ip?: string) {
    if (dto.serverUtcOffsetSeconds % 900 !== 0) {
      throw new BadRequestException("Broker UTC offset must use a 15-minute boundary");
    }
    const login = BigInt(dto.login);
    const existing = await this.prisma.tradingAccount.findUnique({
      where: { login_server: { login, server: dto.server } },
    });

    if (existing && existing.userId !== agent.userId) {
      throw new ConflictException("Trading account is already connected to another user");
    }

    const now = new Date();
    const [, account] = await this.prisma.$transaction([
      this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          status: "ONLINE",
          lastSeenAt: now,
          lastIp: ip,
          version: dto.agentVersion,
          terminalBuild: dto.terminalBuild,
          serverUtcOffsetSeconds: dto.serverUtcOffsetSeconds,
        },
      }),
      this.prisma.tradingAccount.upsert({
        where: { login_server: { login, server: dto.server } },
        create: {
          userId: agent.userId,
          agentId: agent.id,
          login,
          broker: dto.broker,
          server: dto.server,
          currency: dto.currency,
          environment: dto.environment,
          marginMode: dto.marginMode,
          leverage: dto.leverage,
          balance: dto.balance,
          equity: dto.equity,
          tradeAllowed: dto.tradeAllowed,
          expertTradeAllowed: dto.expertTradeAllowed,
          lastSeenAt: now,
        },
        update: {
          agentId: agent.id,
          broker: dto.broker,
          currency: dto.currency,
          environment: dto.environment,
          marginMode: dto.marginMode,
          leverage: dto.leverage,
          balance: dto.balance,
          equity: dto.equity,
          tradeAllowed: dto.tradeAllowed,
          expertTradeAllowed: dto.expertTradeAllowed,
          lastSeenAt: now,
        },
      }),
    ]);

    return {
      protocolVersion: 1,
      serverTime: now.toISOString(),
      accountId: account.id,
      realTradingSystemEnabled: this.allowRealTrading,
      nextHeartbeatSeconds: 15,
    };
  }
}
