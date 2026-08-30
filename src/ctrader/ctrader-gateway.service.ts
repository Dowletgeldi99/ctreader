import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

interface CTraderAccountPayload {
  ctidTraderAccountId: number | string;
  traderLogin?: number | string;
  brokerTitle?: string;
  isLive?: boolean;
}

export interface DiscoveredCTraderAccount {
  ctidTraderAccountId: bigint;
  traderLogin?: bigint;
  brokerTitle?: string;
  environment: "DEMO" | "LIVE";
}

interface OpenApiMessage {
  clientMsgId?: string;
  payloadType: number;
  payload?: {
    ctidTraderAccount?: CTraderAccountPayload[];
    errorCode?: string;
    description?: string;
  };
}

@Injectable()
export class CTraderGatewayService {
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>("CTRADER_CLIENT_ID") ?? "";
    this.clientSecret = config.get<string>("CTRADER_CLIENT_SECRET") ?? "";
  }

  async discoverAccounts(accessToken: string): Promise<DiscoveredCTraderAccount[]> {
    const [demo, live] = await Promise.all([
      this.queryAccounts("demo", accessToken),
      this.queryAccounts("live", accessToken),
    ]);
    const unique = new Map<string, DiscoveredCTraderAccount>();
    for (const account of [...demo, ...live]) {
      unique.set(`${account.environment}:${account.ctidTraderAccountId}`, account);
    }
    return [...unique.values()];
  }

  private queryAccounts(environment: "demo" | "live", accessToken: string): Promise<DiscoveredCTraderAccount[]> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`wss://${environment}.ctraderapi.com:5036`);
      const timeout = setTimeout(() => finish(new Error(`cTrader ${environment} connection timed out`)), 15_000);
      let finished = false;

      const finish = (error?: Error, accounts?: DiscoveredCTraderAccount[]) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        socket.close();
        if (error) reject(error);
        else resolve(accounts ?? []);
      };

      const send = (payloadType: number, payload: Record<string, unknown>) => {
        socket.send(JSON.stringify({
          clientMsgId: crypto.randomUUID(),
          payloadType,
          payload,
        }));
      };

      socket.addEventListener("open", () => {
        send(2100, { clientId: this.clientId, clientSecret: this.clientSecret });
      });
      socket.addEventListener("error", () => finish(new Error(`cTrader ${environment} WebSocket failed`)));
      socket.addEventListener("close", () => {
        if (!finished) finish(new Error(`cTrader ${environment} WebSocket closed unexpectedly`));
      });
      socket.addEventListener("message", async (event) => {
        try {
          const raw = typeof event.data === "string" ? event.data : await event.data.text();
          const message = JSON.parse(raw) as OpenApiMessage;
          if (message.payloadType === 2101) {
            send(2149, { accessToken });
            return;
          }
          if (message.payloadType === 2142) {
            finish(new Error(message.payload?.description ?? message.payload?.errorCode ?? "cTrader API error"));
            return;
          }
          if (message.payloadType !== 2150) return;
          const accounts = (message.payload?.ctidTraderAccount ?? [])
            .filter((account) => account.isLive === (environment === "live"))
            .map((account): DiscoveredCTraderAccount => ({
              ctidTraderAccountId: BigInt(account.ctidTraderAccountId),
              traderLogin: account.traderLogin === undefined ? undefined : BigInt(account.traderLogin),
              brokerTitle: account.brokerTitle,
              environment: environment === "live" ? "LIVE" : "DEMO",
            }));
          finish(undefined, accounts);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Invalid cTrader response"));
        }
      });
    });
  }
}
