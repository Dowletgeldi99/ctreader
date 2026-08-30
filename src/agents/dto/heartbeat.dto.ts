import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from "class-validator";

export enum AccountEnvironmentDto {
  DEMO = "DEMO",
  REAL = "REAL",
  CONTEST = "CONTEST",
}

export enum MarginModeDto {
  NETTING = "NETTING",
  HEDGING = "HEDGING",
  EXCHANGE = "EXCHANGE",
  UNKNOWN = "UNKNOWN",
}

export class HeartbeatDto {
  @IsString()
  @Matches(/^\d{1,20}$/)
  login: string;

  @IsString()
  @Length(1, 120)
  broker: string;

  @IsString()
  @Length(1, 120)
  server: string;

  @IsString()
  @Matches(/^[A-Z0-9]{3,10}$/)
  currency: string;

  @IsEnum(AccountEnvironmentDto)
  environment: AccountEnvironmentDto;

  @IsEnum(MarginModeDto)
  marginMode: MarginModeDto;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  terminalBuild?: number;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  agentVersion?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  leverage?: number;

  @IsInt()
  @Min(-50_400)
  @Max(50_400)
  serverUtcOffsetSeconds: number;

  @IsNumber()
  @Min(0)
  balance: number;

  @IsNumber()
  @Min(0)
  equity: number;

  @IsBoolean()
  tradeAllowed: boolean;

  @IsBoolean()
  expertTradeAllowed: boolean;
}
