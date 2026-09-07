import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createAgentToken, createPairingCode, hashSecret } from "../common/crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ClaimCbotPairingDto } from "./dto/claim-cbot-pairing.dto";

@Injectable()
export class CbotService {
  private readonly pepper: string;
  private readonly ttlSeconds: number;

  constructor(private readonly prisma: PrismaService, config: ConfigService,
    private readonly subscriptions: SubscriptionsService) {
    this.pepper = config.getOrThrow<string>("AGENT_TOKEN_PEPPER");
    this.ttlSeconds = config.getOrThrow<number>("PAIRING_CODE_TTL_SECONDS");
  }

  async createPairingCode(userId: string) {
    const code = createPairingCode();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1_000);
    await this.prisma.cbotPairingCode.create({ data: { userId, codeHash: hashSecret(code, this.pepper), expiresAt } });
    return { code, expiresAt };
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

  async heartbeat(instanceId: string, ip?: string) {
    return this.prisma.cbotInstance.update({ where: { id: instanceId },
      data: { status: "ONLINE", lastSeenAt: new Date(), lastIp: ip },
      select: { id: true, status: true, lastSeenAt: true } });
  }

  async entitlement(userId: string) {
    const subscription = await this.subscriptions.currentForUser(userId);
    return {
      enforcementEnabled: this.subscriptions.isEnforced(),
      status: subscription?.status ?? "NONE",
      plan: subscription?.plan.code ?? null,
      validUntil: subscription?.currentPeriodEnd ?? null,
      permissions: subscription?.entitlement ?? null,
      acceptNewJobs: !this.subscriptions.isEnforced() || Boolean(subscription?.entitlement && ["TRIAL", "ACTIVE"].includes(subscription.status)),
      manageExistingPositions: true,
    };
  }
}
