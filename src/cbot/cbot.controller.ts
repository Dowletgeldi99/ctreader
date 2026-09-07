import { Body, Controller, Get, Ip, Post, Req, UseGuards } from "@nestjs/common";
import { CbotAuthGuard } from "./cbot-auth.guard";
import type { CbotAuthenticatedRequest } from "./cbot-request";
import { CbotService } from "./cbot.service";
import { ClaimCbotPairingDto } from "./dto/claim-cbot-pairing.dto";

@Controller("v1/cbot")
export class CbotController {
  constructor(private readonly cbots: CbotService) {}

  @Post("pairing/claim")
  claim(@Body() dto: ClaimCbotPairingDto, @Ip() ip: string) { return this.cbots.claim(dto, ip); }

  @Post("heartbeat")
  @UseGuards(CbotAuthGuard)
  heartbeat(@Req() request: CbotAuthenticatedRequest, @Ip() ip: string) {
    return this.cbots.heartbeat(request.cbotInstance.id, ip);
  }

  @Get("entitlements")
  @UseGuards(CbotAuthGuard)
  entitlements(@Req() request: CbotAuthenticatedRequest) {
    return this.cbots.entitlement(request.cbotInstance.userId);
  }
}
