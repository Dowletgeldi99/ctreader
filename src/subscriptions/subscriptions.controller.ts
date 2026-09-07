import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { toJsonSafe } from "../common/serialization";
import { GrantSubscriptionDto } from "./dto/grant-subscription.dto";
import { SubscriptionsService } from "./subscriptions.service";

@Controller("v1/admin/subscriptions")
@UseGuards(AdminAuthGuard)
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get("plans")
  plans() { return this.subscriptions.listPlans(); }

  @Get("users")
  async users() { return toJsonSafe(await this.subscriptions.listUsers()); }

  @Post("grant")
  grant(@Body() dto: GrantSubscriptionDto) {
    return this.subscriptions.grantByTelegramId(dto.telegramId, dto.plan, dto.days, "admin-api");
  }

  @Post("suspend")
  suspend(@Body() dto: Pick<GrantSubscriptionDto, "telegramId">) {
    return this.subscriptions.suspendByTelegramId(dto.telegramId, "admin-api");
  }
}
