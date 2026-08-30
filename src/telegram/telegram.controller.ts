import {
  Body,
  Controller,
  Headers,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Update } from "grammy/types";
import { secretsEqual } from "../common/crypto";
import { TelegramService } from "./telegram.service";

@Controller("v1/telegram")
export class TelegramController {
  private readonly webhookSecret: string;

  constructor(
    private readonly telegram: TelegramService,
    config: ConfigService,
  ) {
    this.webhookSecret = config.get<string>("TELEGRAM_WEBHOOK_SECRET") ?? "";
  }

  @Post("webhook")
  async webhook(
    @Headers("x-telegram-bot-api-secret-token") providedSecret: string | undefined,
    @Body() update: Update,
  ): Promise<{ ok: true }> {
    if (!this.webhookSecret) {
      throw new ServiceUnavailableException("Telegram webhook is disabled");
    }
    if (!secretsEqual(providedSecret ?? "", this.webhookSecret)) {
      throw new UnauthorizedException("Invalid Telegram webhook secret");
    }

    await this.telegram.handleUpdate(update);
    return { ok: true };
  }
}
