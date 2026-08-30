import { Module } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { TradeJobsAdminController } from "./trade-jobs-admin.controller";
import { TradeJobsService } from "./trade-jobs.service";

@Module({
  controllers: [TradeJobsAdminController],
  providers: [TradeJobsService, AdminAuthGuard],
  exports: [TradeJobsService],
})
export class TradeJobsModule {}
