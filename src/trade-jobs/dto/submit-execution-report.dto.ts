import {
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";

export enum ExecutionPhaseDto {
  SYNCED = "SYNCED",
  ARMED = "ARMED",
  PREFLIGHT_REJECTED = "PREFLIGHT_REJECTED",
  SUBMITTED = "SUBMITTED",
  ACCEPTED = "ACCEPTED",
  PARTIALLY_FILLED = "PARTIALLY_FILLED",
  FILLED = "FILLED",
  REJECTED = "REJECTED",
  CANCELLED = "CANCELLED",
  CLOSED = "CLOSED",
  MISSED = "MISSED",
  ERROR = "ERROR",
}

export class SubmitExecutionReportDto {
  @IsString()
  @Length(8, 160)
  reportKey: string;

  @IsEnum(ExecutionPhaseDto)
  phase: ExecutionPhaseDto;

  @IsDateString()
  occurredAt: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  orderTicket?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  dealTicket?: string;

  @IsOptional()
  @IsInt()
  retcode?: number;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  message?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  requestedPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  filledPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  filledVolume?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  spreadPoints?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(300_000)
  latencyMs?: number;

  @IsOptional()
  @IsObject()
  raw?: Record<string, unknown>;
}
