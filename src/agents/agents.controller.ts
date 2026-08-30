import { Body, Controller, Get, Ip, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { AgentAuthGuard } from "./agent-auth.guard";
import type { AgentRequest } from "./agent-request";
import { AgentsService } from "./agents.service";
import { HeartbeatDto } from "./dto/heartbeat.dto";
import { SubmitExecutionReportDto } from "../trade-jobs/dto/submit-execution-report.dto";
import { TradeJobsService } from "../trade-jobs/trade-jobs.service";
import { SyncEconomicEventsDto } from "../economic-events/dto/sync-economic-events.dto";
import { EconomicEventsService } from "../economic-events/economic-events.service";
import { ProbeStrategyService } from "../strategy-v2/probe-strategy.service";

@Controller("v1/agent")
@UseGuards(AgentAuthGuard)
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly tradeJobs: TradeJobsService,
    private readonly economicEvents: EconomicEventsService,
    private readonly probeStrategy: ProbeStrategyService,
  ) {}

  @Post("heartbeat")
  heartbeat(@Req() request: AgentRequest, @Body() dto: HeartbeatDto, @Ip() ip: string) {
    return this.agents.heartbeat(request.agent, dto, ip);
  }

  @Post("strategy-v2/candles")
  async ingestStrategyCandle(
    @Req() request: AgentRequest,
    @Body() body: {
      symbol: string;
      timeframe: "M15" | "H1";
      openTime: string;
      open: number;
      high: number;
      low: number;
      close: number;
      spreadPoints?: number;
      point?: number;
    },
  ) {
    await this.probeStrategy.ingestFromMt5(request.agent, { ...body, openTime: new Date(body.openTime) });
    return { accepted: true };
  }

  @Post("strategy-v2/candles/batch")
  async ingestStrategyCandles(
    @Req() request: AgentRequest,
    @Body() body: { candles: Array<{ symbol: string; timeframe: "M15" | "H1"; openTime: string; open: number; high: number; low: number; close: number; spreadPoints?: number; point?: number }> },
  ) {
    if (!Array.isArray(body.candles) || body.candles.length > 300) return { accepted: false };
    let lastM15Index = -1;
    for (let index = 0; index < body.candles.length; index += 1) {
      if (body.candles[index].timeframe === "M15") lastM15Index = index;
    }
    for (const [index, candle] of body.candles.entries()) {
      await this.probeStrategy.ingestFromMt5(
        request.agent,
        { ...candle, openTime: new Date(candle.openTime) },
        index === lastM15Index,
      );
    }
    return { accepted: true, count: body.candles.length };
  }

  @Post("economic-events/sync")
  syncEconomicEvents(@Req() request: AgentRequest, @Body() dto: SyncEconomicEventsDto) {
    return this.economicEvents.syncFromAgent(request.agent, dto);
  }

  @Get("jobs")
  pollJobs(@Req() request: AgentRequest, @Query("horizonMinutes") horizon?: string) {
    return this.tradeJobs.pollForAgent(request.agent, horizon);
  }

  @Get("jobs.mt5")
  async pollJobsForMt5(
    @Req() request: AgentRequest,
    @Res() response: Response,
    @Query("horizonMinutes") horizon?: string,
  ): Promise<void> {
    const payload = await this.tradeJobs.pollForAgentText(request.agent, horizon);
    response.type("text/plain").send(payload);
  }

  @Post("jobs/:jobId/reports")
  submitReport(
    @Req() request: AgentRequest,
    @Param("jobId") jobId: string,
    @Body() dto: SubmitExecutionReportDto,
  ) {
    return this.tradeJobs.submitReport(request.agent, jobId, dto);
  }
}
