import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";

export class GrantSubscriptionDto {
  @IsString()
  @Matches(/^\d{1,20}$/)
  telegramId: string;

  @IsIn(["TRIAL", "BASIC", "PRO"])
  plan: "TRIAL" | "BASIC" | "PRO";

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3660)
  days?: number;
}
