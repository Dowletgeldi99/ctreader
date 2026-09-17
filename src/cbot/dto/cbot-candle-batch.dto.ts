import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";

export class CbotCandleDto {
  @IsString() symbol!: string;
  @IsIn(["M5", "M15", "H1"]) timeframe!: "M5" | "M15" | "H1";
  @IsDateString() openTime!: string;
  @IsNumber() open!: number;
  @IsNumber() high!: number;
  @IsNumber() low!: number;
  @IsNumber() close!: number;
  @IsOptional() @IsNumber() spreadPoints?: number;
  @IsOptional() @IsNumber() point?: number;
  @IsOptional() @IsNumber() @Min(0) tickVolume?: number;
  @IsOptional() @IsBoolean() isHistorical?: boolean;
}

export class CbotCandleBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => CbotCandleDto)
  candles!: CbotCandleDto[];
}
