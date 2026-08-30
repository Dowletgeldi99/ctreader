import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from "class-validator";

export class ClaimPairingDto {
  @IsString()
  @Length(8, 8)
  @Matches(/^[A-Z2-9]+$/)
  code: string;

  @IsString()
  @Length(8, 128)
  deviceId: string;

  @IsString()
  @Length(1, 80)
  name: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  version?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  terminalBuild?: number;
}
