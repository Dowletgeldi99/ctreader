import { Body, Controller, Param, Post, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { CreateTradeJobDto } from "./dto/create-trade-job.dto";
import { TradeJobsService } from "./trade-jobs.service";

@Controller("v1/admin/users/:telegramId/trade-jobs")
@UseGuards(AdminAuthGuard)
export class TradeJobsAdminController {
  constructor(private readonly tradeJobs: TradeJobsService) {}

  @Post()
  create(@Param("telegramId") telegramId: string, @Body() dto: CreateTradeJobDto) {
    return this.tradeJobs.createForTelegramUser(telegramId, dto);
  }
}
