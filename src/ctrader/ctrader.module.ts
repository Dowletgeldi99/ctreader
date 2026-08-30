import { Module } from "@nestjs/common";
import { CTraderController } from "./ctrader.controller";
import { CTraderGatewayService } from "./ctrader-gateway.service";
import { CTraderService } from "./ctrader.service";
import { CTraderMockExecutionService } from "./ctrader-mock-execution.service";
import { CTraderExecutionService } from "./ctrader-execution.service";

@Module({
  controllers: [CTraderController],
  providers: [CTraderService, CTraderGatewayService, CTraderMockExecutionService, CTraderExecutionService],
  exports: [CTraderService, CTraderMockExecutionService],
})
export class CTraderModule {}
