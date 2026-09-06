import {
  decodeMessageKind,
  decodeRuntimeHeartbeatEvent,
  encodeRuntimeHeartbeatAckEvent,
  encodeRuntimeLivenessReadyEvent,
  MOBIUS_PROTOCOL_VERSION,
  RUNTIME_HEARTBEAT_ACK_KIND,
  RUNTIME_HEARTBEAT_KIND,
  RUNTIME_LIVENESS_READY_KIND,
} from "@moxt-ai/mobius-protocol";
import {
  ChannelActor,
  type ChannelPeers,
  type ChannelSocket,
  ProjectScope,
} from "@moxt-ai/mobius-relay-core";
import {
  INTERNAL_CHANNEL_ID_HEADER,
  INTERNAL_PROJECT_ID_HEADER,
  INTERNAL_TENANT_ID_HEADER,
} from "../cloudflare-channel-runtime.ts";
import { CloudflareSessionRuntime } from "../cloudflare-session-runtime.ts";
import {
  type SessionConfigurationEnvironment,
  sessionQuotaFromEnvironment,
} from "../session-configuration.ts";

const DAEMON_TAG = "daemon";
const HOST_TAG = "host";

interface RuntimeRelayEnvironment extends SessionConfigurationEnvironment {
  readonly DIRECTORY_DATABASE: D1Database;
  readonly SESSION_RELAY: DurableObjectNamespace;
}

type SocketAttachment =
  | {
      readonly projectId: string;
      readonly role: "daemon" | "replaced-daemon";
      readonly runtimeId: string;
      readonly tenantId: string;
    }
  | {
      readonly projectId: string;
      readonly role: "host";
      readonly runtimeId: string;
      readonly tenantId: string;
    };

function readAttachment(value: unknown): SocketAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Missing WebSocket attachment");
  }
  const role = Reflect.get(value, "role");
  const runtimeId = Reflect.get(value, "runtimeId");
  const tenantId = Reflect.get(value, "tenantId");
  const projectId = Reflect.get(value, "projectId");
  if (
    (role !== "daemon" && role !== "host" && role !== "replaced-daemon") ||
    typeof runtimeId !== "string" ||
    typeof tenantId !== "string" ||
    typeof projectId !== "string"
  ) {
    throw new Error("Invalid WebSocket attachment");
  }
  return { projectId, role, runtimeId, tenantId };
}

function accessFromRequest(request: Request): {
  readonly runtimeId: string;
  readonly scope: ProjectScope;
} {
  const runtimeId = request.headers.get(INTERNAL_CHANNEL_ID_HEADER);
  const tenantId = request.headers.get(INTERNAL_TENANT_ID_HEADER);
  const projectId = request.headers.get(INTERNAL_PROJECT_ID_HEADER);
  if (runtimeId === null || tenantId === null || projectId === null) {
    throw new Error("Missing verified channel access");
  }
  return { runtimeId, scope: new ProjectScope(tenantId, projectId) };
}

class CloudflareChannelSocket implements ChannelSocket {
  readonly #socket: WebSocket;

  constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  readonly close = (code: number, reason: string): void => {
    this.#socket.close(code, reason);
  };

  readonly isOpen = (): boolean => this.#socket.readyState === WebSocket.OPEN;

  readonly isSame = (socket: ChannelSocket): boolean =>
    socket instanceof CloudflareChannelSocket &&
    socket.#socket === this.#socket;

  readonly send = (message: string): void => {
    this.#socket.send(message);
  };
}

class CloudflareChannelPeers implements ChannelPeers {
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.#state = state;
  }

  readonly daemons = (): readonly ChannelSocket[] =>
    this.#state
      .getWebSockets(DAEMON_TAG)
      .flatMap((socket) =>
        readAttachment(socket.deserializeAttachment()).role === "daemon"
          ? [new CloudflareChannelSocket(socket)]
          : [],
      );

  readonly hosts = (): readonly ChannelSocket[] =>
    this.#state
      .getWebSockets(HOST_TAG)
      .map((socket) => new CloudflareChannelSocket(socket));
}

export class RuntimeRelay {
  readonly #peers: CloudflareChannelPeers;
  readonly #sessions: CloudflareSessionRuntime;
  readonly #state: DurableObjectState;

  constructor(state: DurableObjectState, environment: RuntimeRelayEnvironment) {
    this.#peers = new CloudflareChannelPeers(state);
    this.#sessions = new CloudflareSessionRuntime(
      environment.SESSION_RELAY,
      environment.DIRECTORY_DATABASE,
      sessionQuotaFromEnvironment(environment),
    );
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    let access: ReturnType<typeof accessFromRequest>;
    try {
      access = accessFromRequest(request);
    } catch {
      return Response.json(
        {
          error: {
            code: "unauthorized",
            message: "Verified channel access is required",
          },
        },
        { status: 401 },
      );
    }
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/daemon")) {
      return await this.acceptDaemonSocket(
        access.runtimeId,
        access.scope,
        new URL(request.url).searchParams.get("liveness") === "1",
        request.signal,
      );
    }
    if (pathname.endsWith("/host")) {
      return await this.acceptHostSocket(
        access.runtimeId,
        access.scope,
        request.signal,
      );
    }
    return new Response(null, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
    await this.withSocketSignal(socket, async (signal) => {
      const attachment = readAttachment(socket.deserializeAttachment());
      const channelSocket = new CloudflareChannelSocket(socket);
      const scope = new ProjectScope(attachment.tenantId, attachment.projectId);
      if (attachment.role === "replaced-daemon") {
        socket.close(1012, "Daemon connection replaced");
        return;
      }
      if (attachment.role === "daemon") {
        if (typeof message === "string") {
          try {
            if (decodeMessageKind(message) === RUNTIME_HEARTBEAT_KIND) {
              const heartbeat = decodeRuntimeHeartbeatEvent(message);
              socket.send(
                encodeRuntimeHeartbeatAckEvent({
                  heartbeatId: heartbeat.heartbeatId,
                  kind: RUNTIME_HEARTBEAT_ACK_KIND,
                  protocolVersion: MOBIUS_PROTOCOL_VERSION,
                }),
              );
              return;
            }
          } catch {
            socket.close(1008, "Invalid protocol message");
            return;
          }
        }
        await this.actor(attachment.runtimeId, scope).receiveDaemonMessage(
          channelSocket,
          message,
          signal,
        );
        return;
      }
      await this.actor(attachment.runtimeId, scope).receiveHostMessage(
        channelSocket,
        message,
        signal,
      );
    });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = readAttachment(socket.deserializeAttachment());
    if (attachment.role === "daemon") {
      await this.actor(
        attachment.runtimeId,
        new ProjectScope(attachment.tenantId, attachment.projectId),
      ).detachDaemon(
        new CloudflareChannelSocket(socket),
        new AbortController().signal,
      );
    }
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error");
  }

  private readonly acceptDaemonSocket = async (
    runtimeId: string,
    scope: ProjectScope,
    livenessRequested: boolean,
    signal: AbortSignal,
  ): Promise<Response> => {
    const previousSockets = this.#state.getWebSockets(DAEMON_TAG);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    await this.actor(runtimeId, scope).attachDaemon(signal);
    for (const socket of previousSockets) {
      const attachment = readAttachment(socket.deserializeAttachment());
      socket.serializeAttachment({
        ...attachment,
        role: "replaced-daemon",
      });
      socket.close(1012, "Daemon connection replaced");
    }
    server.serializeAttachment({
      projectId: scope.projectId,
      role: "daemon",
      runtimeId,
      tenantId: scope.tenantId,
    });
    this.#state.acceptWebSocket(server, [DAEMON_TAG]);
    if (livenessRequested) {
      server.send(
        encodeRuntimeLivenessReadyEvent({
          kind: RUNTIME_LIVENESS_READY_KIND,
          protocolVersion: MOBIUS_PROTOCOL_VERSION,
        }),
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  };

  private readonly acceptHostSocket = async (
    runtimeId: string,
    scope: ProjectScope,
    signal: AbortSignal,
  ): Promise<Response> => {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({
      projectId: scope.projectId,
      role: "host",
      runtimeId,
      tenantId: scope.tenantId,
    });
    this.#state.acceptWebSocket(server, [HOST_TAG]);
    await this.actor(runtimeId, scope).attachHost(
      new CloudflareChannelSocket(server),
      signal,
    );
    return new Response(null, { status: 101, webSocket: client });
  };

  private readonly actor = (
    runtimeId: string,
    scope: ProjectScope,
  ): ChannelActor =>
    new ChannelActor(runtimeId, scope, this.#sessions, this.#peers);

  private readonly withSocketSignal = async (
    socket: WebSocket,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    const controller = new AbortController();
    const handleClose = (): void => {
      controller.abort(new Error("The channel socket closed"));
    };
    socket.addEventListener("close", handleClose, { once: true });
    try {
      await operation(controller.signal);
    } finally {
      socket.removeEventListener("close", handleClose);
    }
  };
}
