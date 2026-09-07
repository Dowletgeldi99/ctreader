import { Body, Controller, Get, Ip, NotFoundException, Param, Post, Query, Req, Res, StreamableFile, UseGuards } from "@nestjs/common";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import { CbotAuthGuard } from "./cbot-auth.guard";
import type { CbotAuthenticatedRequest } from "./cbot-request";
import { CbotService } from "./cbot.service";
import { ClaimCbotPairingDto } from "./dto/claim-cbot-pairing.dto";
import { SubmitExecutionReportDto } from "../trade-jobs/dto/submit-execution-report.dto";
import { CbotHeartbeatDto } from "./dto/cbot-heartbeat.dto";

@Controller("v1/cbot")
export class CbotController {
  constructor(private readonly cbots: CbotService) {}

  @Post("pairing/claim")
  claim(@Body() dto: ClaimCbotPairingDto, @Ip() ip: string) { return this.cbots.claim(dto, ip); }

  @Get("download")
  download(@Res({ passthrough: true }) response: Response) {
    const file = join(process.cwd(), "artifacts", "TradeTmConnector.algo");
    if (!existsSync(file)) throw new NotFoundException("cBot release artifact is not available in this development build");
    response.set({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="TradeTmConnector.algo"',
      "Cache-Control": "public, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    });
    return new StreamableFile(createReadStream(file));
  }

  @Post("heartbeat")
  @UseGuards(CbotAuthGuard)
  heartbeat(@Req() request: CbotAuthenticatedRequest, @Body() dto: CbotHeartbeatDto, @Ip() ip: string) {
    return this.cbots.heartbeat(request.cbotInstance.id, dto, ip);
  }

  @Get("entitlements")
  @UseGuards(CbotAuthGuard)
  entitlements(@Req() request: CbotAuthenticatedRequest) {
    return this.cbots.entitlement(request.cbotInstance.userId);
  }

  @Get("jobs")
  @UseGuards(CbotAuthGuard)
  jobs(@Req() request: CbotAuthenticatedRequest, @Query("horizonMinutes") horizon?: string) {
    return this.cbots.poll(request.cbotInstance.id, request.cbotInstance.userId, horizon ? Number(horizon) : 1440);
  }

  @Post("jobs/:jobId/reports")
  @UseGuards(CbotAuthGuard)
  report(@Req() request: CbotAuthenticatedRequest, @Param("jobId") jobId: string,
    @Body() dto: SubmitExecutionReportDto) {
    return this.cbots.report(request.cbotInstance.id, jobId, dto);
  }
}
