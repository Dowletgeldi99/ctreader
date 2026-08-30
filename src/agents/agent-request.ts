import type { Request } from "express";
import type { Agent } from "../generated/prisma/client";

export interface AgentRequest extends Request {
  agent: Agent;
}
