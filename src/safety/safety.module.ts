import { Global, Module } from "@nestjs/common";
import { AdminAuthGuard } from "../common/admin-auth.guard";
import { SafetyController } from "./safety.controller";
import { SafetyService } from "./safety.service";

@Global()
@Module({
  controllers: [SafetyController],
  providers: [SafetyService, AdminAuthGuard],
  exports: [SafetyService],
})
export class SafetyModule {}
