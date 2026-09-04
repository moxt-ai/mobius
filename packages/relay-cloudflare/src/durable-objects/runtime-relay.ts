import {
  ChannelActor,
  type ChannelPeers,
  type ChannelSocket,
} from "@moxt-ai/mobius-relay-core";
import { DurableObjectSessionStore } from "./durable-object-session-store.ts";
import { DurableObjectTurnStore } from "./durable-object-turn-store.ts";

const DAEMON_TAG = "daemon";
const HOST_TAG = "host";

abstract class SocketAttachment {
  readonly runtimeId: string;

  protected constructor(runtimeId: string) {
    this.runtimeId = runtimeId;
  }
}

class DaemonSocketAttachment extends SocketAttachment {
  constructor(runtimeId: string) {
    super(runtimeId);
  }
}

class HostSocketAttachment extends SocketAttachment {
  constructor(runtimeId: string) {
    super(runtimeId);
  }
}

function decodeAttachment(value: unknown): SocketAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Missing WebSocket attachment");
  }
  if (!("role" in value) || !("runtimeId" in value)) {
    throw new Error("Invalid WebSocket attachment");
  }
  if (typeof value.role !== "string" || typeof value.runtimeId !== "string") {
    throw new Error("Invalid WebSocket attachment");
  }
  if (value.role === DAEMON_TAG) {
    return new DaemonSocketAttachment(value.runtimeId);
  }
  if (value.role === HOST_TAG) {
    return new HostSocketAttachment(value.runtimeId);
  }
  throw new Error("Invalid WebSocket attachment");
}

function runtimeIdFromPath(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const runtimeIndex = segments.indexOf("channels");
  const runtimeId = segments[runtimeIndex + 1];
  if (runtimeIndex < 0 || runtimeId === undefined) {
    throw new Error("Missing runtime ID");
  }
  return runtimeId;
}

class CloudflareChannelSocket implements ChannelSocket {
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
  }

  readonly close = (code: number, reason: string): void => {
    this.socket.close(code, reason);
  };

  readonly isOpen = (): boolean => this.socket.readyState === 1;

  readonly isSame = (socket: ChannelSocket): boolean =>
    socket instanceof CloudflareChannelSocket && socket.socket === this.socket;

  readonly send = (message: string): void => {
    this.socket.send(message);
  };
}

class CloudflareChannelPeers implements ChannelPeers {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  readonly daemons = (): readonly ChannelSocket[] =>
    this.state
      .getWebSockets(DAEMON_TAG)
      .map((socket) => new CloudflareChannelSocket(socket));

  readonly hosts = (): readonly ChannelSocket[] =>
    this.state
      .getWebSockets(HOST_TAG)
      .map((socket) => new CloudflareChannelSocket(socket));
}

export class RuntimeRelay {
  private readonly peers: CloudflareChannelPeers;
  private readonly sessionStore: DurableObjectSessionStore;
  private readonly state: DurableObjectState;
  private readonly turnStore: DurableObjectTurnStore;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.peers = new CloudflareChannelPeers(state);
    this.sessionStore = new DurableObjectSessionStore(state.storage);
    this.turnStore = new DurableObjectTurnStore(state.storage);
  }

  fetch(request: Request): Response {
    const url = new URL(request.url);
    const runtimeId = runtimeIdFromPath(url.pathname);
    if (url.pathname.endsWith("/history")) {
      return Response.json(this.actor(runtimeId).readHistory());
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    if (url.pathname.endsWith("/daemon")) {
      return this.acceptDaemonSocket(runtimeId);
    }
    if (url.pathname.endsWith("/host")) {
      return this.acceptHostSocket(runtimeId);
    }
    return new Response(null, { status: 404 });
  }

  webSocketMessage(socket: WebSocket, message: unknown): void {
    const attachment = decodeAttachment(socket.deserializeAttachment());
    const channelSocket = new CloudflareChannelSocket(socket);
    if (attachment instanceof DaemonSocketAttachment) {
      this.actor(attachment.runtimeId).receiveDaemonMessage(
        channelSocket,
        message,
      );
      return;
    }
    if (attachment instanceof HostSocketAttachment) {
      this.actor(attachment.runtimeId).receiveHostMessage(
        channelSocket,
        message,
      );
      return;
    }
    socket.close(1008, "Invalid connection role");
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = decodeAttachment(socket.deserializeAttachment());
    if (attachment instanceof DaemonSocketAttachment) {
      this.actor(attachment.runtimeId).detachDaemon(
        new CloudflareChannelSocket(socket),
      );
    }
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error");
  }

  private acceptDaemonSocket(runtimeId: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role: DAEMON_TAG, runtimeId });
    this.state.acceptWebSocket(server, [DAEMON_TAG]);
    this.actor(runtimeId).attachDaemon();
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptHostSocket(runtimeId: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role: HOST_TAG, runtimeId });
    this.state.acceptWebSocket(server, [HOST_TAG]);
    this.actor(runtimeId).attachHost(new CloudflareChannelSocket(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  private actor(runtimeId: string): ChannelActor {
    return new ChannelActor(
      runtimeId,
      this.turnStore,
      this.peers,
      undefined,
      this.sessionStore,
    );
  }
}
