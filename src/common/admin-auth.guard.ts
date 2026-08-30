import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { secretsEqual } from "./crypto";

@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly expectedKey: string;

  constructor(config: ConfigService) {
    this.expectedKey = config.getOrThrow<string>("ADMIN_API_KEY");
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header("x-admin-api-key") ?? "";
    if (!secretsEqual(provided, this.expectedKey)) {
      throw new UnauthorizedException("Invalid admin API key");
    }
    return true;
  }
}
