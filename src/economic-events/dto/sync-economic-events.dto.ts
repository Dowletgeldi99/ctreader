import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export enum EventImportanceDto {
  LOW = "LOW",
  MODERATE = "MODERATE",
  HIGH = "HIGH",
  UNKNOWN = "UNKNOWN",
}

export class SyncEconomicEventDto {
  @IsString()
  @Length(1, 80)
  externalId: string;

  @IsString()
  @Length(1, 300)
  title: string;

  @IsString()
  @Matches(/^[A-Z]{3,10}$/)
  currency: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  countryCode?: string;

  @IsEnum(EventImportanceDto)
  importance: EventImportanceDto;

  @IsInt()
  @Min(946_684_800)
  @Max(4_102_444_800)
  scheduledAtServerUnix: number;

  @IsOptional()
  @IsNumber()
  forecast?: number;

  @IsOptional()
  @IsNumber()
  previous?: number;

  @IsOptional()
  @IsNumber()
  actual?: number;
}

export class SyncEconomicEventsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SyncEconomicEventDto)
  events: SyncEconomicEventDto[];
}
