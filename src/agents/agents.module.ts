import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { AgentAuthGuard } from "./agent-auth.guard";
import { TradeJobsModule } from "../trade-jobs/trade-jobs.module";
import { EconomicEventsModule } from "../economic-events/economic-events.module";
import { ProbeStrategyModule } from "../strategy-v2/probe-strategy.module";

@Module({
  imports: [TradeJobsModule, EconomicEventsModule, ProbeStrategyModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentAuthGuard],
  exports: [AgentsService, AgentAuthGuard],
})
export class AgentsModule {}
