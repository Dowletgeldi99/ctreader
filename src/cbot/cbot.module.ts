import { Module } from "@nestjs/common";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { CbotAuthGuard } from "./cbot-auth.guard";
import { CbotController } from "./cbot.controller";
import { CbotService } from "./cbot.service";
import { CbotWebSocketGateway } from "./cbot-websocket.gateway";
import { ProbeStrategyModule } from "../strategy-v2/probe-strategy.module";

@Module({
  imports: [SubscriptionsModule, ProbeStrategyModule],
  controllers: [CbotController],
  providers: [CbotService, CbotAuthGuard, CbotWebSocketGateway],
  exports: [CbotService],
})
export class CbotModule {}
