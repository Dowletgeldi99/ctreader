import { BadRequestException, Injectable } from "@nestjs/common";
import type { Agent, EventImportance } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SyncEconomicEventsDto } from "./dto/sync-economic-events.dto";

@Injectable()
export class EconomicEventsService {
  constructor(private readonly prisma: PrismaService) {}

  async syncFromAgent(agent: Agent, dto: SyncEconomicEventsDto) {
    const operations = dto.events.map((event) => {
      const scheduledAt = new Date(
        (event.scheduledAtServerUnix - agent.serverUtcOffsetSeconds) * 1_000,
      );
      const key = {
        source: "MT5",
        externalId: event.externalId,
        scheduledAt,
      };
      const values = {
        title: event.title,
        currency: event.currency,
        countryCode: event.countryCode,
        importance: event.importance,
        forecast: event.forecast,
        previous: event.previous,
        actual: event.actual,
      };

      return this.prisma.economicEvent.upsert({
        where: { source_externalId_scheduledAt: key },
        create: { ...key, ...values },
        update: values,
      });
    });

    await this.prisma.$transaction(operations);
    return { accepted: dto.events.length, serverTime: new Date().toISOString() };
  }

  findById(id: string) {
    return this.prisma.economicEvent.findUnique({ where: { id } });
  }

  list(query: { from?: string; to?: string; currency?: string; importance?: string }) {
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to ? new Date(query.to) : new Date(from.getTime() + 7 * 86_400_000);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) {
      throw new BadRequestException("Invalid event time range");
    }
    if (to.getTime() - from.getTime() > 31 * 86_400_000) {
      throw new BadRequestException("Event range cannot exceed 31 days");
    }

    const importance = query.importance?.toUpperCase();
    if (importance && !["LOW", "MODERATE", "HIGH", "UNKNOWN"].includes(importance)) {
      throw new BadRequestException("Invalid importance");
    }

    return this.prisma.economicEvent.findMany({
      where: {
        scheduledAt: { gte: from, lte: to },
        currency: query.currency?.toUpperCase(),
        importance: importance as EventImportance | undefined,
      },
      orderBy: { scheduledAt: "asc" },
      take: 500,
    });
  }
}
