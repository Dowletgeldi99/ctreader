import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { EconomicEventsService } from "./economic-events.service";

@Controller("v1/admin/economic-events")
@UseGuards(AdminAuthGuard)
export class EconomicEventsAdminController {
  constructor(private readonly events: EconomicEventsService) {}

  @Get()
  list(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("currency") currency?: string,
    @Query("importance") importance?: string,
  ) {
    return this.events.list({ from, to, currency, importance });
  }
}
