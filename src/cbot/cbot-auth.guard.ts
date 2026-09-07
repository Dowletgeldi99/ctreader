import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { hashSecret } from "../common/crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { CbotAuthenticatedRequest } from "./cbot-request";

@Injectable()
export class CbotAuthGuard implements CanActivate {
  private readonly pepper: string;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.pepper = config.getOrThrow<string>("AGENT_TOKEN_PEPPER");
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CbotAuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const raw = Array.isArray(authorization) ? authorization[0] : authorization;
    const token = raw?.startsWith("Bearer ") ? raw.slice(7) : "";
    if (!token) throw new UnauthorizedException("Missing cBot bearer token");
    const instance = await this.prisma.cbotInstance.findUnique({ where: { tokenHash: hashSecret(token, this.pepper) } });
    if (!instance || instance.status === "REVOKED") throw new UnauthorizedException("Invalid or revoked cBot token");
    request.cbotInstance = instance;
    return true;
  }
}
