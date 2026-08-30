import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { hashSecret } from "../common/crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { AgentRequest } from "./agent-request";

@Injectable()
export class AgentAuthGuard implements CanActivate {
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.pepper = config.getOrThrow<string>("AGENT_TOKEN_PEPPER");
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;

    if (!token) throw new UnauthorizedException("Missing agent bearer token");

    const agent = await this.prisma.agent.findUnique({
      where: { tokenHash: hashSecret(token, this.pepper) },
    });

    if (!agent || agent.status === "REVOKED") {
      throw new UnauthorizedException("Invalid or revoked agent token");
    }

    request.agent = agent;
    return true;
  }
}
