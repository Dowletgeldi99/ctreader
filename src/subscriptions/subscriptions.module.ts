import { Module } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { SubscriptionsController } from "./subscriptions.controller";
import { SubscriptionsService } from "./subscriptions.service";

@Module({
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, AdminAuthGuard],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
