import { IsIn, IsOptional, IsString, Length, Matches } from "class-validator";

export class CbotHeartbeatDto {
  @IsString()
  @Matches(/^\d{1,20}$/)
  accountNumber: string;

  @IsString()
  @Length(1, 100)
  broker: string;

  @IsIn(["DEMO", "LIVE"])
  environment: "DEMO" | "LIVE";

  @IsOptional()
  @IsString()
  @Length(1, 40)
  symbol?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  version?: string;
}
