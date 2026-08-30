import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { SafetyService } from "./safety.service";

@Controller("v1/admin/safety")
@UseGuards(AdminAuthGuard)
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get()
  status() { return this.safety.status(); }

  @Post("halt")
  halt(@Body() body: { reason?: unknown }) {
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : undefined;
    return this.safety.halt(reason);
  }

  @Post("resume")
  resume() { return this.safety.resume(); }
}
