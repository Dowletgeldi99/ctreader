import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "./config/environment";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./health/health.module";
import { UsersModule } from "./users/users.module";
import { PairingModule } from "./pairing/pairing.module";
import { AgentsModule } from "./agents/agents.module";
import { TradeJobsModule } from "./trade-jobs/trade-jobs.module";
import { TelegramModule } from "./telegram/telegram.module";
import { EconomicEventsModule } from "./economic-events/economic-events.module";
import { CTraderModule } from "./ctrader/ctrader.module";
import { ProbeStrategyModule } from "./strategy-v2/probe-strategy.module";
import { SafetyModule } from "./safety/safety.module";
import { SubscriptionsModule } from "./subscriptions/subscriptions.module";
import { CbotModule } from "./cbot/cbot.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    SubscriptionsModule,
    CbotModule,
    SafetyModule,
    HealthModule,
    UsersModule,
    PairingModule,
    AgentsModule,
    TradeJobsModule,
    EconomicEventsModule,
    CTraderModule,
    ProbeStrategyModule,
    TelegramModule,
  ],
})
export class AppModule {}
