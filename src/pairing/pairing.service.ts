import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createAgentToken, createPairingCode, hashSecret } from "../common/crypto";
import { PrismaService } from "../prisma/prisma.service";
import { ClaimPairingDto } from "./dto/claim-pairing.dto";

@Injectable()
export class PairingService {
  private readonly pepper: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.pepper = config.getOrThrow<string>("AGENT_TOKEN_PEPPER");
    this.ttlSeconds = config.getOrThrow<number>("PAIRING_CODE_TTL_SECONDS");
  }

  async create(userId: string): Promise<{ code: string; expiresAt: Date }> {
    const code = createPairingCode();
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1_000);

    await this.prisma.pairingCode.create({
      data: {
        userId,
        codeHash: hashSecret(code, this.pepper),
        expiresAt,
      },
    });

    return { code, expiresAt };
  }

  async claim(dto: ClaimPairingDto, ip?: string) {
    const codeHash = hashSecret(dto.code.toUpperCase(), this.pepper);
    const pairing = await this.prisma.pairingCode.findUnique({ where: { codeHash } });

    if (!pairing) throw new NotFoundException("Pairing code not found");
    if (pairing.claimedAt) throw new ConflictException("Pairing code already used");
    if (pairing.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException("Pairing code expired");
    }

    const existing = await this.prisma.agent.findUnique({ where: { deviceId: dto.deviceId } });
    if (existing && existing.userId !== pairing.userId) {
      throw new ConflictException("Device is already paired with another user");
    }

    const token = createAgentToken();
    const tokenHash = hashSecret(token, this.pepper);

    const agent = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.pairingCode.updateMany({
        where: { id: pairing.id, claimedAt: null, expiresAt: { gt: new Date() } },
        data: { claimedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ConflictException("Pairing code cannot be claimed");

      return tx.agent.upsert({
        where: { deviceId: dto.deviceId },
        create: {
          userId: pairing.userId,
          deviceId: dto.deviceId,
          name: dto.name,
          tokenHash,
          status: "ONLINE",
          version: dto.version,
          terminalBuild: dto.terminalBuild,
          lastIp: ip,
          lastSeenAt: new Date(),
        },
        update: {
          name: dto.name,
          tokenHash,
          status: "ONLINE",
          version: dto.version,
          terminalBuild: dto.terminalBuild,
          lastIp: ip,
          lastSeenAt: new Date(),
        },
      });
    });

    return {
      protocolVersion: 1,
      agentId: agent.id,
      token,
      message: "Store this token locally. It will not be shown again.",
    };
  }
}
