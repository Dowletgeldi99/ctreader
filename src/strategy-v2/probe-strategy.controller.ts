import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { CandleInput, ProbeStrategyService } from "./probe-strategy.service";

@Controller("v1/strategy-v2")
@UseGuards(AdminAuthGuard)
export class ProbeStrategyController {
  constructor(private readonly strategy: ProbeStrategyService) {}

  @Post("candles")
  async ingest(@Body() candle: Omit<CandleInput, "openTime"> & { openTime: string }) {
    await this.strategy.ingest({ ...candle, openTime: new Date(candle.openTime) });
    return { accepted: true };
  }
}
