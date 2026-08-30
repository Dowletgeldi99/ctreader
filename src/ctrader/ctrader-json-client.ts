export interface CTraderMessage {
  clientMsgId?: string;
  payloadType: number;
  payload?: Record<string, unknown>;
}

export class CTraderJsonClient {
  private socket?: WebSocket;
  private readonly pending = new Map<string, { types: Set<number>; resolve: (message: CTraderMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(message: CTraderMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private heartbeat?: NodeJS.Timeout;
  private intentionalClose = false;

  constructor(private readonly environment: "demo" | "live") {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`wss://${this.environment}.ctraderapi.com:5036`);
      this.socket = socket;
      const timer = setTimeout(() => reject(new Error("cTrader connection timed out")), 15_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("cTrader WebSocket failed")); });
      socket.addEventListener("message", (event) => void this.receive(event));
      socket.addEventListener("close", (event) => {
        if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
        const error = new Error(`cTrader WebSocket closed (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`);
        this.failAll(error);
        if (!this.intentionalClose) for (const listener of this.closeListeners) listener(error);
      });
    });
    this.heartbeat = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.send(51, {});
    }, 20_000);
    this.heartbeat.unref();
  }

  onMessage(listener: (message: CTraderMessage) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener); return () => this.closeListeners.delete(listener);
  }

  send(payloadType: number, payload: Record<string, unknown>, clientMsgId = crypto.randomUUID()): string {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("cTrader socket is not open");
    this.socket.send(JSON.stringify({ clientMsgId, payloadType, payload }));
    return clientMsgId;
  }

  request(payloadType: number, payload: Record<string, unknown>, responseTypes: number[], timeoutMs = 15_000): Promise<CTraderMessage> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cTrader request ${payloadType} timed out`)); }, timeoutMs);
      this.pending.set(id, { types: new Set(responseTypes), resolve, reject, timer });
      this.send(payloadType, payload, id);
    });
  }

  close(): void {
    this.intentionalClose = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.failAll(new Error("cTrader client closed"));
    this.socket?.close(); this.socket = undefined;
    this.closeListeners.clear();
  }

  private async receive(event: MessageEvent): Promise<void> {
    try {
      const raw = typeof event.data === "string" ? event.data : await event.data.text();
      const message = JSON.parse(raw) as CTraderMessage;
      const waiting = message.clientMsgId ? this.pending.get(message.clientMsgId) : undefined;
      if (waiting && (waiting.types.has(message.payloadType) || [50, 2142, 2132].includes(message.payloadType))) {
        clearTimeout(waiting.timer); this.pending.delete(message.clientMsgId!);
        if ([50, 2142, 2132].includes(message.payloadType)) waiting.reject(new Error(`${message.payload?.errorCode ?? "CTRADER_ERROR"}: ${message.payload?.description ?? "Request rejected"}`));
        else waiting.resolve(message);
      }
      if (!waiting && [50, 2142, 2132].includes(message.payloadType)) {
        this.failAll(new Error(`${message.payload?.errorCode ?? "CTRADER_ERROR"}: ${message.payload?.description ?? "Request rejected"}`));
      }
      for (const listener of this.listeners) listener(message);
    } catch { /* malformed broker frames are ignored; request timeout remains authoritative */ }
  }

  private failAll(error: Error): void {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
  }
}
