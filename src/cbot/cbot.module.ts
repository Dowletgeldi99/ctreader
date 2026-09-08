import { Module } from "@nestjs/common";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { CbotAuthGuard } from "./cbot-auth.guard";
import { CbotController } from "./cbot.controller";
import { CbotService } from "./cbot.service";
import { CbotWebSocketGateway } from "./cbot-websocket.gateway";

@Module({
  imports: [SubscriptionsModule],
  controllers: [CbotController],
  providers: [CbotService, CbotAuthGuard, CbotWebSocketGateway],
  exports: [CbotService],
})
export class CbotModule {}
