import { Module } from "@nestjs/common";
import { PairingModule } from "../pairing/pairing.module";
import { UsersModule } from "../users/users.module";
import { TelegramController } from "./telegram.controller";
import { TelegramService } from "./telegram.service";
import { TradeJobsModule } from "../trade-jobs/trade-jobs.module";
import { EconomicEventsModule } from "../economic-events/economic-events.module";
import { TelegramSessionsService } from "./telegram-sessions.service";
import { CTraderModule } from "../ctrader/ctrader.module";
import { ProbeStrategyModule } from "../strategy-v2/probe-strategy.module";

@Module({
  imports: [UsersModule, PairingModule, TradeJobsModule, EconomicEventsModule, CTraderModule, ProbeStrategyModule],
  controllers: [TelegramController],
  providers: [TelegramService, TelegramSessionsService],
})
export class TelegramModule {}
