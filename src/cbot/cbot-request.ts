import type { CbotInstance } from "../generated/prisma/client";

export interface CbotAuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  cbotInstance: CbotInstance;
}
