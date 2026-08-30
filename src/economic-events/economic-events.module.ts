import { Module } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { EconomicEventsAdminController } from "./economic-events-admin.controller";
import { EconomicEventsService } from "./economic-events.service";

@Module({
  controllers: [EconomicEventsAdminController],
  providers: [EconomicEventsService, AdminAuthGuard],
  exports: [EconomicEventsService],
})
export class EconomicEventsModule {}
