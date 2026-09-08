import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CbotService } from "./cbot.service";
import { ClaimCbotPairingDto } from "./dto/claim-cbot-pairing.dto";
import { CbotHeartbeatDto } from "./dto/cbot-heartbeat.dto";
import { SubmitExecutionReportDto } from "../trade-jobs/dto/submit-execution-report.dto";

type ClientMessage = { id?: string; type?: string; token?: string; payload?: unknown };

interface WsConnection {
  socket: Socket;
  buffer: Buffer;
  fragments: Buffer[];
  fragmentOpcode?: number;
  remoteIp?: string;
  windowStartedAt: number;
  requestCount: number;
}

@Injectable()
export class CbotWebSocketGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CbotWebSocketGateway.name);
  private readonly connections = new Set<WsConnection>();
  private server?: Server;
  private readonly upgradeHandler = (request: import("node:http").IncomingMessage, socket: Socket, head: Buffer) => {
    if (request.url?.split("?")[0] !== "/api/v1/cbot/ws") return;
    const key = request.headers["sec-websocket-key"];
    const upgrade = request.headers.upgrade;
    if (typeof key !== "string" || upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return;
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`, "\r\n"].join("\r\n"));
    if (this.connections.size >= 1_000) { socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }
    const connection: WsConnection = { socket, buffer: head, fragments: [], windowStartedAt: Date.now(), requestCount: 0,
      remoteIp: request.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ?? socket.remoteAddress };
    this.connections.add(connection);
    socket.setKeepAlive(true, 30_000);
    socket.setTimeout(90_000, () => this.close(connection, 1001, "Idle timeout"));
    socket.on("data", (chunk: Buffer) => { connection.buffer = Buffer.concat([connection.buffer, chunk]); this.consume(connection); });
    socket.on("close", () => this.connections.delete(connection));
    socket.on("error", () => this.connections.delete(connection));
    if (head.length) this.consume(connection);
  };

  constructor(private readonly adapterHost: HttpAdapterHost, private readonly cbots: CbotService) {}

  onApplicationBootstrap() {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on("upgrade", this.upgradeHandler);
    this.logger.log("cBot WebSocket gateway ready at /api/v1/cbot/ws");
  }

  onApplicationShutdown() {
    this.server?.off("upgrade", this.upgradeHandler);
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
  }

  private consume(connection: WsConnection) {
    while (connection.buffer.length >= 2) {
      const first = connection.buffer[0];
      const second = connection.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (connection.buffer.length < 4) return;
        length = connection.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (connection.buffer.length < 10) return;
        const big = connection.buffer.readBigUInt64BE(2);
        if (big > 1_048_576n) return this.close(connection, 1009, "Message too large");
        length = Number(big); offset = 10;
      }
      if (!masked) return this.close(connection, 1002, "Client frames must be masked");
      if (connection.buffer.length < offset + 4 + length) return;
      const mask = connection.buffer.subarray(offset, offset + 4); offset += 4;
      const payload = Buffer.from(connection.buffer.subarray(offset, offset + length));
      connection.buffer = connection.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];

      if (opcode === 0x8) return this.close(connection, 1000, "Closing");
      if (opcode === 0x9) { this.sendFrame(connection, 0xA, payload); continue; }
      if (opcode === 0xA) continue;
      if (opcode !== 0 && opcode !== 1) return this.close(connection, 1003, "Text messages only");
      if (opcode === 1) { connection.fragments = [payload]; connection.fragmentOpcode = opcode; }
      else if (!connection.fragmentOpcode) return this.close(connection, 1002, "Unexpected continuation");
      else connection.fragments.push(payload);
      const total = connection.fragments.reduce((sum, part) => sum + part.length, 0);
      if (total > 1_048_576) return this.close(connection, 1009, "Message too large");
      if (!fin) continue;
      const text = Buffer.concat(connection.fragments).toString("utf8");
      connection.fragments = []; connection.fragmentOpcode = undefined;
      void this.handle(connection, text);
    }
  }

  private async handle(connection: WsConnection, text: string) {
    const now = Date.now();
    if (now - connection.windowStartedAt >= 60_000) { connection.windowStartedAt = now; connection.requestCount = 0; }
    if (++connection.requestCount > 300) return this.close(connection, 1008, "Rate limit exceeded");
    let message: ClientMessage;
    try { message = JSON.parse(text) as ClientMessage; }
    catch { return this.respond(connection, undefined, false, undefined, "INVALID_JSON"); }
    const id = typeof message.id === "string" ? message.id.slice(0, 100) : undefined;
    try {
      if (!id || !message.type) throw new Error("id and type are required");
      if (message.type === "PAIR") {
        const dto = await this.dto(ClaimCbotPairingDto, message.payload);
        return this.respond(connection, id, true, await this.cbots.claim(dto, connection.remoteIp));
      }
      if (!message.token) throw new Error("Missing bearer token");
      const instance = await this.cbots.authenticateToken(message.token);
      if (message.type === "HEARTBEAT") {
        const dto = await this.dto(CbotHeartbeatDto, message.payload);
        return this.respond(connection, id, true, await this.cbots.heartbeat(instance.id, dto, connection.remoteIp));
      }
      if (message.type === "POLL") {
        const payload = (message.payload ?? {}) as { horizonMinutes?: unknown };
        const horizon = payload.horizonMinutes === undefined ? 1440 : Number(payload.horizonMinutes);
        return this.respond(connection, id, true, await this.cbots.poll(instance.id, instance.userId, horizon));
      }
      if (message.type === "REPORT") {
        const payload = (message.payload ?? {}) as { jobId?: unknown; report?: unknown };
        if (typeof payload.jobId !== "string") throw new Error("jobId is required");
        const report = await this.dto(SubmitExecutionReportDto, payload.report);
        return this.respond(connection, id, true, await this.cbots.report(instance.id, payload.jobId, report));
      }
      throw new Error(`Unsupported message type ${message.type}`);
    } catch (error) {
      const candidate = error as { message?: string; status?: number; getStatus?: () => number };
      const status = typeof candidate.getStatus === "function" ? candidate.getStatus() : candidate.status;
      this.respond(connection, id, false, undefined, candidate.message ?? "Request failed", status);
    }
  }

  private async dto<T extends object>(type: new () => T, value: unknown): Promise<T> {
    const instance = plainToInstance(type, value ?? {});
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) throw new Error(errors.flatMap((item) => Object.values(item.constraints ?? {})).join("; "));
    return instance;
  }

  private respond(connection: WsConnection, id: string | undefined, ok: boolean, payload?: unknown, error?: string, status?: number) {
    this.sendText(connection, JSON.stringify({ id, ok, payload, error, status, serverTime: new Date().toISOString() }));
  }

  private sendText(connection: WsConnection, text: string) { this.sendFrame(connection, 1, Buffer.from(text, "utf8")); }

  private sendFrame(connection: WsConnection, opcode: number, payload: Buffer) {
    if (connection.socket.destroyed) return;
    let header: Buffer;
    if (payload.length < 126) { header = Buffer.from([0x80 | opcode, payload.length]); }
    else if (payload.length <= 65_535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    connection.socket.write(Buffer.concat([header, payload]));
  }

  private close(connection: WsConnection, code: number, reason: string) {
    const reasonBuffer = Buffer.from(reason.slice(0, 100), "utf8");
    const payload = Buffer.alloc(2 + reasonBuffer.length); payload.writeUInt16BE(code, 0); reasonBuffer.copy(payload, 2);
    this.sendFrame(connection, 8, payload); connection.socket.end(); this.connections.delete(connection);
  }
}
