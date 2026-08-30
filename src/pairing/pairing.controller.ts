import { Body, Controller, Ip, Post } from "@nestjs/common";
import { ClaimPairingDto } from "./dto/claim-pairing.dto";
import { PairingService } from "./pairing.service";

@Controller("v1/pairing")
export class PairingController {
  constructor(private readonly pairing: PairingService) {}

  @Post("claim")
  claim(@Body() dto: ClaimPairingDto, @Ip() ip: string) {
    return this.pairing.claim(dto, ip);
  }
}
