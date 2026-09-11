import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

export enum TradeDirectionDto {
  BUY = "BUY",
  SELL = "SELL",
}

export enum ExecutionModeDto {
  MARKET = "MARKET",
  STRADDLE = "STRADDLE",
  MULTI = "MULTI",
  NEWS_REVERSAL = "NEWS_REVERSAL",
}

export enum VolumeAllocationModeDto {
  SPLIT_TOTAL = "SPLIT_TOTAL",
  FULL_EACH = "FULL_EACH",
}

export enum RiskModeDto {
  FIXED_LOT = "FIXED_LOT",
  RISK_PERCENT = "RISK_PERCENT",
}

export enum ExecutionVenueDto {
  MT5 = "MT5",
  CTRADER = "CTRADER",
  CBOT = "CBOT",
}

export class CreateTradeJobDto {
  @IsOptional()
  @IsEnum(ExecutionVenueDto)
  executionVenue: ExecutionVenueDto = ExecutionVenueDto.MT5;

  @IsUUID()
  accountId: string;

  @IsOptional()
  @IsUUID()
  economicEventId?: string;

  @IsOptional()
  @IsString()
  @Length(8, 128)
  idempotencyKey?: string;

  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,32}$/)
  symbol: string;

  @IsEnum(TradeDirectionDto)
  direction: TradeDirectionDto;

  @IsOptional()
  @IsEnum(ExecutionModeDto)
  executionMode: ExecutionModeDto = ExecutionModeDto.MARKET;

  @IsEnum(RiskModeDto)
  riskMode: RiskModeDto;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  fixedLot?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  riskPercent?: number;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  stopLossPoints: number;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  takeProfitPoints: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  deviationPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  maxSpreadPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(60)
  armSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(5_000)
  maxLatenessMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  entryDistancePoints?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  pendingExpirySeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(5)
  multiTradesPerSide?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  multiNextStepPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  multiNextSlPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  multiNextTpPoints?: number;

  @IsOptional()
  @IsEnum(VolumeAllocationModeDto)
  volumeAllocationMode?: VolumeAllocationModeDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  takeProfit2Points?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  takeProfit3Points?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  reversalTp1BufferPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  reversalTp2BufferPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  reversalGapPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(3600)
  managementSeconds?: number;

  @IsDateString()
  executeAt: string;
}
