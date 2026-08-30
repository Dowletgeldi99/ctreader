import { Module } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { ProbeStrategyController } from "./probe-strategy.controller";
import { ProbeStrategyService } from "./probe-strategy.service";

@Module({
  controllers: [ProbeStrategyController],
  providers: [ProbeStrategyService, AdminAuthGuard],
  exports: [ProbeStrategyService],
})
export class ProbeStrategyModule {}
