import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";

export class CbotCandleDto {
  @IsString() symbol!: string;
  @IsIn(["M15", "H1"]) timeframe!: "M15" | "H1";
  @IsDateString() openTime!: string;
  @IsNumber() open!: number;
  @IsNumber() high!: number;
  @IsNumber() low!: number;
  @IsNumber() close!: number;
  @IsOptional() @IsNumber() spreadPoints?: number;
  @IsOptional() @IsNumber() point?: number;
}

export class CbotCandleBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => CbotCandleDto)
  candles!: CbotCandleDto[];
}
