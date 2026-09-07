import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeMessageKind,
  decodeRuntimeHeartbeatEvent,
  encodeRuntimeHeartbeatAckEvent,
  encodeWorkspaceListCommand,
  MOBIUS_API_PREFIX,
  RUNTIME_HEARTBEAT_ACK_KIND,
  RUNTIME_HEARTBEAT_KIND,
  RUNTIME_LIVENESS_READY_KIND,
  WORKSPACE_ENTRIES_KIND,
  WORKSPACE_LIST_KIND,
} from "../../protocol/src/index.ts";
import { AuditStore } from "../src/audit/audit-store.ts";
import { createDaemonConfig } from "../src/config.ts";
import { runDaemon } from "../src/run-daemon.ts";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function restoreEnvironmentVariable(
  name: string,
  previous: string | undefined,
): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error): void => reject(error);
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail);
      resolve();
    });
  });
}

function readPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test relay did not bind to a TCP port");
  }
  return address.port;
}

class ClientWebSocketFrame {
  readonly opcode: number;
  readonly text: string;

  constructor(opcode: number, text: string) {
    this.opcode = opcode;
    this.text = text;
  }
}

function readClientFrame(socket: Duplex): Promise<ClientWebSocketFrame> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const fail = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.removeListener("close", handleClose);
      socket.removeListener("data", handleData);
      socket.removeListener("error", fail);
    };
    const handleClose = (): void => {
      fail(new Error("Daemon connection closed before sending a frame"));
    };
    const handleData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 6) {
        return;
      }
      const encodedLength = buffered.readUInt8(1) & 0x7f;
      if (encodedLength === 127) {
        fail(new Error("Test relay received an oversized client frame"));
        return;
      }
      const headerLength = encodedLength === 126 ? 4 : 2;
      if (buffered.byteLength < headerLength + 4) {
        return;
      }
      const payloadLength =
        encodedLength === 126 ? buffered.readUInt16BE(2) : encodedLength;
      const frameLength = headerLength + 4 + payloadLength;
      if (buffered.byteLength < frameLength) {
        return;
      }
      const mask = buffered.subarray(headerLength, headerLength + 4);
      const payload = Buffer.from(
        buffered.subarray(headerLength + 4, frameLength),
      );
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload.writeUInt8(
          payload.readUInt8(index) ^ mask.readUInt8(index % 4),
          index,
        );
      }
      const opcode = buffered.readUInt8(0) & 0x0f;
      cleanup();
      resolve(new ClientWebSocketFrame(opcode, payload.toString("utf8")));
    };
    socket.on("close", handleClose);
    socket.on("data", handleData);
    socket.on("error", fail);
  });
}

function writeServerTextFrame(socket: Duplex, text: string): void {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength > 65_535) {
    throw new Error("Test relay message is too large");
  }
  const header =
    payload.byteLength < 126
      ? Buffer.from([0x81, payload.byteLength])
      : Buffer.from([
          0x81,
          126,
          payload.byteLength >> 8,
          payload.byteLength & 0xff,
        ]);
  socket.write(Buffer.concat([header, payload]));
}

function respondToClientClose(socket: Duplex): void {
  socket.on("data", (chunk: Buffer) => {
    if (chunk.byteLength > 0 && (chunk.readUInt8(0) & 0x0f) === 8) {
      socket.end(Buffer.from([0x88, 0]));
    }
  });
}

describe("daemon relay connection liveness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Given a liveness-capable relay stops acknowledging heartbeats, When the acknowledgement deadline expires, Then the daemon reconnects", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-daemon-heartbeat-"),
    );
    const defaultWorkspace = join(stateDirectory, "workspace");
    await mkdir(defaultWorkspace);
    const relay = createServer((request, response) => {
      if (
        request.method === "PUT" &&
        request.url ===
          `${MOBIUS_API_PREFIX}/channels/heartbeat-channel/catalog`
      ) {
        request.resume();
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(426);
      response.end();
    });
    const sockets = new Set<Duplex>();
    const upgradeWaiters: Array<() => void> = [];
    const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
    const daemonSockets: Duplex[] = [];
    let livenessRequested = false;
    const waitForUpgrade = (): Promise<void> =>
      new Promise((resolve) => upgradeWaiters.push(resolve));
    relay.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    relay.on("upgrade", (request, socket) => {
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}${WEBSOCKET_GUID}`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      livenessRequested =
        new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get(
          "liveness",
        ) === "1";
      daemonSockets.push(socket);
      clientFrames.push(readClientFrame(socket));
      respondToClientClose(socket);
      writeServerTextFrame(
        socket,
        JSON.stringify({
          kind: RUNTIME_LIVENESS_READY_KIND,
        }),
      );
      upgradeWaiters.shift()?.();
    });
    await listen(relay);

    const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
    const audit = new AuditStore(auditDatabasePath);
    const cancellation = new AbortController();
    const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
    const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
    const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
    const previousNoProxy = process.env["NO_PROXY"];
    const previousLowerNoProxy = process.env["no_proxy"];
    process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
    process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
    process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
    process.env["NO_PROXY"] = "127.0.0.1,localhost";
    process.env["no_proxy"] = "127.0.0.1,localhost";
    const config = createDaemonConfig({
      defaultWorkspace,
      auditDatabasePath,
      channelId: "heartbeat-channel",
      relayUrl: new URL(
        `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/heartbeat-channel/daemon`,
      ),
    });

    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    const firstConnection = waitForUpgrade();
    const daemon = runDaemon(config, audit, cancellation.signal);

    try {
      await firstConnection;
      const firstFrame = clientFrames[0];
      if (firstFrame === undefined) {
        throw new Error("Test relay did not observe the daemon connection");
      }
      const heartbeatFrame = await firstFrame;
      expect(livenessRequested).toBe(true);
      expect(heartbeatFrame.opcode).toBe(1);
      const firstHeartbeat = decodeRuntimeHeartbeatEvent(heartbeatFrame.text);
      expect(firstHeartbeat.kind).toBe(RUNTIME_HEARTBEAT_KIND);
      const firstSocket = daemonSockets[0];
      if (firstSocket === undefined) {
        throw new Error("Test relay did not retain the daemon connection");
      }
      const controlResponse = readClientFrame(firstSocket);
      writeServerTextFrame(
        firstSocket,
        encodeRuntimeHeartbeatAckEvent({
          heartbeatId: firstHeartbeat.heartbeatId,
          kind: RUNTIME_HEARTBEAT_ACK_KIND,
        }),
      );
      writeServerTextFrame(
        firstSocket,
        encodeWorkspaceListCommand({
          bindingId: "workspace",
          directoryId: "default",
          kind: WORKSPACE_LIST_KIND,
          requestId: "acknowledgement-barrier",
        }),
      );
      expect(decodeMessageKind((await controlResponse).text)).toBe(
        WORKSPACE_ENTRIES_KIND,
      );

      const unacknowledgedHeartbeat = readClientFrame(firstSocket);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(
        decodeRuntimeHeartbeatEvent((await unacknowledgedHeartbeat).text)
          .heartbeatId,
      ).not.toBe(firstHeartbeat.heartbeatId);

      const refreshedConnection = waitForUpgrade();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(500);
      await refreshedConnection;
      const refreshedFrame = clientFrames[1];
      if (refreshedFrame === undefined) {
        throw new Error("Test relay did not observe the refreshed connection");
      }
      expect((await refreshedFrame).opcode).toBe(1);
    } finally {
      cancellation.abort();
      await vi.runAllTimersAsync();
      await daemon;
      audit.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        relay.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
      restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
      restoreEnvironmentVariable(
        "MOBIUS_STATE_DIRECTORY",
        previousStateDirectory,
      );
      restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
      restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });

  it("Given the Agent catalog endpoint is temporarily unavailable, When the daemon starts and later refreshes an idle connection, Then its relay connection remains available", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "mobius-daemon-liveness-"),
    );
    const defaultWorkspace = join(stateDirectory, "workspace");
    await mkdir(defaultWorkspace);
    let catalogRequestCount = 0;
    let observeCatalogFailure = (): void => undefined;
    const catalogFailure = new Promise<void>((resolve) => {
      observeCatalogFailure = resolve;
    });
    const relay = createServer((request, response) => {
      if (
        request.method === "PUT" &&
        request.url === `${MOBIUS_API_PREFIX}/channels/liveness-channel/catalog`
      ) {
        catalogRequestCount += 1;
        request.resume();
        response.writeHead(catalogRequestCount === 1 ? 503 : 204);
        response.end();
        if (catalogRequestCount === 1) {
          observeCatalogFailure();
        }
        return;
      }
      response.writeHead(426);
      response.end();
    });
    const sockets = new Set<Duplex>();
    const upgradeWaiters: Array<() => void> = [];
    const requestedUrls: string[] = [];
    const clientFrames: Array<Promise<ClientWebSocketFrame>> = [];
    let connectionCount = 0;
    const waitForUpgrade = (): Promise<void> =>
      new Promise((resolve) => upgradeWaiters.push(resolve));
    relay.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    });
    relay.on("upgrade", (request, socket) => {
      requestedUrls.push(request.url ?? "");
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(`${key}${WEBSOCKET_GUID}`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      clientFrames.push(readClientFrame(socket));
      respondToClientClose(socket);
      writeServerTextFrame(
        socket,
        encodeWorkspaceListCommand({
          bindingId: "workspace",
          directoryId: "default",
          kind: WORKSPACE_LIST_KIND,
          requestId: `connection-${clientFrames.length.toString()}`,
        }),
      );
      connectionCount += 1;
      upgradeWaiters.shift()?.();
    });
    await listen(relay);

    const auditDatabasePath = join(stateDirectory, "daemon.sqlite");
    const audit = new AuditStore(auditDatabasePath);
    const cancellation = new AbortController();
    const previousCodexPath = process.env["MOBIUS_CODEX_PATH"];
    const previousClaudePath = process.env["MOBIUS_CLAUDE_PATH"];
    const previousStateDirectory = process.env["MOBIUS_STATE_DIRECTORY"];
    const previousNoProxy = process.env["NO_PROXY"];
    const previousLowerNoProxy = process.env["no_proxy"];
    process.env["MOBIUS_CODEX_PATH"] = join(stateDirectory, "missing-codex");
    process.env["MOBIUS_CLAUDE_PATH"] = join(stateDirectory, "missing-claude");
    process.env["MOBIUS_STATE_DIRECTORY"] = stateDirectory;
    process.env["NO_PROXY"] = "127.0.0.1,localhost";
    process.env["no_proxy"] = "127.0.0.1,localhost";
    const config = createDaemonConfig({
      defaultWorkspace,
      auditDatabasePath,
      channelId: "liveness-channel",
      relayUrl: new URL(
        `ws://127.0.0.1:${readPort(relay)}${MOBIUS_API_PREFIX}/channels/liveness-channel/daemon`,
      ),
    });

    vi.useFakeTimers({ toFake: ["Date", "clearTimeout", "setTimeout"] });
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    const firstConnection = waitForUpgrade();
    const daemon = runDaemon(config, audit, cancellation.signal);

    try {
      await catalogFailure;
      await firstConnection;
      const firstResponse = clientFrames[0];
      if (firstResponse === undefined) {
        throw new Error("Test relay did not observe the daemon response");
      }
      expect(decodeMessageKind((await firstResponse).text)).toBe(
        WORKSPACE_ENTRIES_KIND,
      );
      expect(connectionCount).toBe(1);

      const refreshedConnection = waitForUpgrade();
      await vi.advanceTimersByTimeAsync(20 * 60 * 1_000);
      await vi.advanceTimersByTimeAsync(500);
      await refreshedConnection;
      const refreshedResponse = clientFrames[1];
      if (refreshedResponse === undefined) {
        throw new Error("Test relay did not observe the refreshed daemon");
      }
      expect(decodeMessageKind((await refreshedResponse).text)).toBe(
        WORKSPACE_ENTRIES_KIND,
      );

      expect({ catalogRequestCount, connectionCount, requestedUrls }).toEqual({
        catalogRequestCount: 2,
        connectionCount: 2,
        requestedUrls: [
          `${MOBIUS_API_PREFIX}/channels/liveness-channel/daemon?liveness=1`,
          `${MOBIUS_API_PREFIX}/channels/liveness-channel/daemon?liveness=1`,
        ],
      });
    } finally {
      cancellation.abort();
      await vi.runAllTimersAsync();
      await daemon;
      audit.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        relay.close((error) => {
          if (error === undefined) {
            resolve();
            return;
          }
          reject(error);
        });
      });
      restoreEnvironmentVariable("MOBIUS_CODEX_PATH", previousCodexPath);
      restoreEnvironmentVariable("MOBIUS_CLAUDE_PATH", previousClaudePath);
      restoreEnvironmentVariable(
        "MOBIUS_STATE_DIRECTORY",
        previousStateDirectory,
      );
      restoreEnvironmentVariable("NO_PROXY", previousNoProxy);
      restoreEnvironmentVariable("no_proxy", previousLowerNoProxy);
      await rm(stateDirectory, { force: true, recursive: true });
    }
  });
});
