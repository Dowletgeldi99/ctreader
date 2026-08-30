import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TelegramSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  set<T extends object>(userId: string, state: string, data: T) {
    const jsonData = data as unknown as Prisma.InputJsonObject;
    return this.prisma.telegramSession.upsert({
      where: { userId },
      create: {
        userId,
        state,
        data: jsonData,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
      update: {
        state,
        data: jsonData,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
  }

  async get(userId: string) {
    const session = await this.prisma.telegramSession.findUnique({ where: { userId } });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.clear(userId);
      return null;
    }
    return session;
  }

  clear(userId: string) {
    return this.prisma.telegramSession.deleteMany({ where: { userId } });
  }
}
