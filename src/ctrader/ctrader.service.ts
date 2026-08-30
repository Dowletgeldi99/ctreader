import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, hashSecret } from "../common/crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CTraderGatewayService } from "./ctrader-gateway.service";

interface TokenResponse {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  errorCode?: string;
  description?: string;
}

@Injectable()
export class CTraderService {
  private readonly enabled: boolean;
  private readonly mockMode: boolean;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly encryptionKey: string;
  private readonly statePepper: string;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly gateway: CTraderGatewayService,
  ) {
    this.enabled = config.get<boolean>("CTRADER_ENABLED") ?? false;
    this.mockMode = config.get<boolean>("CTRADER_MOCK_MODE") ?? false;
    this.clientId = config.get<string>("CTRADER_CLIENT_ID") ?? "";
    this.clientSecret = config.get<string>("CTRADER_CLIENT_SECRET") ?? "";
    this.redirectUri = config.get<string>("CTRADER_REDIRECT_URI") ?? "";
    this.encryptionKey = config.get<string>("CTRADER_TOKEN_ENCRYPTION_KEY") ?? "";
    this.statePepper = config.getOrThrow<string>("AGENT_TOKEN_PEPPER");
  }

  isEnabled(): boolean {
    return this.enabled || this.mockMode;
  }

  isMockMode(): boolean {
    return this.mockMode;
  }

  async ensureMockAccount(userId: string) {
    if (!this.mockMode) throw new ServiceUnavailableException("cTrader mock mode is disabled");
    const existing = await this.prisma.cTraderAccount.findFirst({
      where: { userId, brokerTitle: "cTrader Mock" },
    });
    if (existing) return existing;

    const connection = await this.prisma.cTraderConnection.create({
      data: {
        userId,
        accessTokenCiphertext: "mock",
        refreshTokenCiphertext: "mock",
        accessTokenExpiresAt: new Date("2999-01-01T00:00:00.000Z"),
        status: "ACTIVE",
      },
    });
    return this.prisma.cTraderAccount.create({
      data: {
        userId,
        connectionId: connection.id,
        ctidTraderAccountId: BigInt(Date.now()),
        traderLogin: BigInt(Date.now()),
        brokerTitle: "cTrader Mock",
        environment: "DEMO",
      },
    });
  }

  async createAuthorizationUrl(userId: string): Promise<string> {
    this.assertEnabled();
    const state = randomBytes(32).toString("base64url");
    await this.prisma.cTraderOAuthState.create({
      data: {
        userId,
        stateHash: hashSecret(state, this.statePepper),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const url = new URL("https://id.ctrader.com/my/settings/openapi/grantingaccess/");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "trading");
    url.searchParams.set("product", "web");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async completeAuthorization(code: string, state: string): Promise<number> {
    this.assertEnabled();
    if (!code || !state) throw new BadRequestException("Missing OAuth code or state");
    const stateHash = hashSecret(state, this.statePepper);
    const oauthState = await this.prisma.cTraderOAuthState.findUnique({ where: { stateHash } });
    if (!oauthState || oauthState.consumedAt || oauthState.expiresAt <= new Date()) {
      throw new BadRequestException("OAuth link is invalid or expired");
    }

    const claimed = await this.prisma.cTraderOAuthState.updateMany({
      where: { id: oauthState.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new BadRequestException("OAuth link was already used");

    const token = await this.exchangeCode(code);
    const connection = await this.prisma.cTraderConnection.create({
      data: {
        userId: oauthState.userId,
        accessTokenCiphertext: encryptSecret(token.accessToken, this.encryptionKey),
        refreshTokenCiphertext: encryptSecret(token.refreshToken, this.encryptionKey),
        accessTokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000),
      },
    });

    try {
      const accounts = await this.gateway.discoverAccounts(token.accessToken);
      await this.prisma.$transaction([
        ...accounts.map((account) => this.prisma.cTraderAccount.upsert({
          where: {
            userId_ctidTraderAccountId_environment: {
              userId: oauthState.userId,
              ctidTraderAccountId: account.ctidTraderAccountId,
              environment: account.environment,
            },
          },
          create: { ...account, userId: oauthState.userId, connectionId: connection.id },
          update: {
            userId: oauthState.userId,
            connectionId: connection.id,
            traderLogin: account.traderLogin,
            brokerTitle: account.brokerTitle,
            enabled: true,
          },
        })),
        this.prisma.cTraderConnection.update({
          where: { id: connection.id },
          data: { status: "ACTIVE", lastError: null },
        }),
      ]);
      return accounts.length;
    } catch (error) {
      await this.prisma.cTraderConnection.update({
        where: { id: connection.id },
        data: {
          status: "ERROR",
          lastError: error instanceof Error ? error.message.slice(0, 500) : "Account discovery failed",
        },
      });
      throw new ServiceUnavailableException("Authorization succeeded, but cTrader accounts could not be loaded");
    }
  }

  listUserAccounts(userId: string) {
    return this.prisma.cTraderAccount.findMany({
      where: { userId, ...(this.mockMode ? {} : { OR: [{ brokerTitle: null }, { brokerTitle: { not: "cTrader Mock" } }] }) },
      orderBy: [{ environment: "asc" }, { createdAt: "asc" }],
    });
  }

  async accessTokenForConnection(connectionId: string): Promise<string> {
    const connection = await this.prisma.cTraderConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.status !== "ACTIVE") throw new ServiceUnavailableException("cTrader connection is not active");
    if (connection.accessTokenExpiresAt.getTime() > Date.now() + 5 * 60_000) {
      return decryptSecret(connection.accessTokenCiphertext, this.encryptionKey);
    }
    const refreshToken = decryptSecret(connection.refreshTokenCiphertext, this.encryptionKey);
    const token = await this.refreshAccessToken(refreshToken);
    await this.prisma.cTraderConnection.update({ where: { id: connection.id }, data: {
      accessTokenCiphertext: encryptSecret(token.accessToken, this.encryptionKey),
      refreshTokenCiphertext: encryptSecret(token.refreshToken, this.encryptionKey),
      accessTokenExpiresAt: new Date(Date.now() + token.expiresIn * 1000), status: "ACTIVE", lastError: null,
    }});
    return token.accessToken;
  }

  credentials(): { clientId: string; clientSecret: string } {
    this.assertEnabled();
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  private async exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const url = new URL("https://openapi.ctrader.com/apps/token");
    url.searchParams.set("grant_type", "authorization_code");
    url.searchParams.set("code", code);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("client_secret", this.clientSecret);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as TokenResponse;
    if (!response.ok || !body.accessToken || !body.refreshToken || !body.expiresIn) {
      throw new BadRequestException(body.description ?? body.errorCode ?? "cTrader token exchange failed");
    }
    return { accessToken: body.accessToken, refreshToken: body.refreshToken, expiresIn: body.expiresIn };
  }

  private async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const url = new URL("https://openapi.ctrader.com/apps/token");
    url.searchParams.set("grant_type", "refresh_token"); url.searchParams.set("refresh_token", refreshToken);
    url.searchParams.set("client_id", this.clientId); url.searchParams.set("client_secret", this.clientSecret);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as TokenResponse;
    if (!response.ok || !body.accessToken || !body.refreshToken || !body.expiresIn)
      throw new ServiceUnavailableException(body.description ?? body.errorCode ?? "cTrader token refresh failed");
    return { accessToken: body.accessToken, refreshToken: body.refreshToken, expiresIn: body.expiresIn };
  }

  private assertEnabled(): void {
    if (!this.enabled) throw new ServiceUnavailableException("cTrader integration is disabled");
  }
}
