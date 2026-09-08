import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CbotWebSocketGateway } from "../src/cbot/cbot-websocket.gateway";

describe("CbotWebSocketGateway", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  });

  it("accepts a real websocket upgrade and handles PAIR", async () => {
    server = createServer((_request, response) => response.writeHead(404).end());
    const claim = vi.fn().mockResolvedValue({ protocolVersion: 1, instanceId: "instance-1", token: "token-1" });
    const gateway = new CbotWebSocketGateway(
      { httpAdapter: { getHttpServer: () => server } } as never,
      { claim } as never,
    );
    gateway.onApplicationBootstrap();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/cbot/ws`);
      client.onerror = () => reject(new Error("WebSocket connection failed"));
      client.onopen = () => client.send(JSON.stringify({
        id: "PAIR-test", type: "PAIR", payload: {
          code: "ABCD2345", instanceKey: "instance-key-123", accountNumber: "8310587",
          broker: "FxPro", environment: "LIVE", symbol: "XAUUSD", version: "1.0.0",
        },
      }));
      client.onmessage = (event) => { resolve(JSON.parse(String(event.data)) as Record<string, unknown>); client.close(); };
    });

    expect(response).toMatchObject({ id: "PAIR-test", ok: true,
      payload: { instanceId: "instance-1", token: "token-1" } });
    expect(claim).toHaveBeenCalledOnce();
    gateway.onApplicationShutdown();
  });
});
