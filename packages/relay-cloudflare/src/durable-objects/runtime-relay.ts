import {
    decodeMessageKind,
    decodeRuntimeHeartbeatEvent,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeLivenessReadyEvent,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
} from "@moxt-ai/mobius-protocol";
import { ChannelActor, type ChannelPeers, type ChannelSocket, ProjectScope } from "@moxt-ai/mobius-relay-core";
import {
    INTERNAL_CHANNEL_ID_HEADER,
    INTERNAL_HOST_CREDENTIAL_ID_HEADER,
    INTERNAL_PROJECT_ID_HEADER,
    INTERNAL_RUNTIME_ID_HEADER,
    INTERNAL_TENANT_ID_HEADER,
} from "../cloudflare-channel-runtime.ts";
import { CloudflareSessionRuntime } from "../cloudflare-session-runtime.ts";
import { type SessionConfigurationEnvironment, sessionQuotaFromEnvironment } from "../session-configuration.ts";

const DAEMON_TAG = "daemon";
const HOST_TAG = "host";

interface RuntimeRelayEnvironment extends SessionConfigurationEnvironment {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

type SocketAttachment =
    | {
          readonly connectionEpoch: number;
          readonly connectionId: string;
          readonly projectId: string;
          readonly role: "daemon" | "replaced-daemon";
          readonly runtimeId: string;
          readonly tenantId: string;
      }
    | {
          readonly channelId: string;
          readonly credentialId: string;
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
    const connectionEpoch = Reflect.get(value, "connectionEpoch");
    const connectionId = Reflect.get(value, "connectionId");
    const channelId = Reflect.get(value, "channelId");
    const credentialId = Reflect.get(value, "credentialId");
    if (
        (role !== "daemon" && role !== "host" && role !== "replaced-daemon") ||
        typeof runtimeId !== "string" ||
        typeof tenantId !== "string" ||
        typeof projectId !== "string"
    ) {
        throw new Error("Invalid WebSocket attachment");
    }
    if (role === "host") {
        if (typeof channelId !== "string" || typeof credentialId !== "string") {
            throw new Error("Invalid host WebSocket attachment");
        }
        return {
            channelId,
            credentialId,
            projectId,
            role,
            runtimeId,
            tenantId,
        };
    }
    if (
        typeof connectionEpoch !== "number" ||
        !Number.isSafeInteger(connectionEpoch) ||
        connectionEpoch < 1 ||
        typeof connectionId !== "string" ||
        connectionId.length === 0
    ) {
        throw new Error("Invalid daemon WebSocket attachment");
    }
    return {
        connectionEpoch,
        connectionId,
        projectId,
        role,
        runtimeId,
        tenantId,
    };
}

interface CurrentRuntimeConnection {
    readonly connectionEpoch: number;
    readonly connectionId: string;
    readonly runtimeId: string;
    readonly state: "offline" | "online";
}

function accessFromRequest(request: Request): {
    readonly channelId: string;
    readonly runtimeId: string;
    readonly scope: ProjectScope;
} {
    const channelId = request.headers.get(INTERNAL_CHANNEL_ID_HEADER);
    const runtimeId = request.headers.get(INTERNAL_RUNTIME_ID_HEADER);
    const tenantId = request.headers.get(INTERNAL_TENANT_ID_HEADER);
    const projectId = request.headers.get(INTERNAL_PROJECT_ID_HEADER);
    if (channelId === null || runtimeId === null || tenantId === null || projectId === null) {
        throw new Error("Missing verified channel access");
    }
    return {
        channelId,
        runtimeId,
        scope: new ProjectScope(tenantId, projectId),
    };
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
        socket instanceof CloudflareChannelSocket && socket.#socket === this.#socket;

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
        this.#state.getWebSockets(HOST_TAG).map((socket) => new CloudflareChannelSocket(socket));
}

export class RuntimeRelay {
    #daemonMessageTail: Promise<void> = Promise.resolve();
    readonly #database: D1Database;
    readonly #peers: CloudflareChannelPeers;
    readonly #sessions: CloudflareSessionRuntime;
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState, environment: RuntimeRelayEnvironment) {
        state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS runtime_connection_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        runtime_id TEXT NOT NULL,
        connection_epoch INTEGER NOT NULL,
        connection_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('online', 'offline')),
        connected_at INTEGER NOT NULL,
        disconnected_at INTEGER
      ) STRICT;
    `);
        this.#peers = new CloudflareChannelPeers(state);
        this.#database = environment.DIRECTORY_DATABASE;
        this.#sessions = new CloudflareSessionRuntime({
            gateways: { sessionRelay: environment.SESSION_RELAY, directoryDatabase: environment.DIRECTORY_DATABASE },
            config: { quota: sessionQuotaFromEnvironment(environment) },
        });
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
        const pathname = new URL(request.url).pathname;
        if (request.method === "DELETE" && pathname.endsWith("/host-credentials/revoke")) {
            const credentialId = request.headers.get(INTERNAL_HOST_CREDENTIAL_ID_HEADER);
            if (credentialId === null) {
                return Response.json(
                    {
                        error: {
                            code: "unauthorized",
                            message: "Verified host credential access is required",
                        },
                    },
                    { status: 401 },
                );
            }
            this.disconnectHostCredential(access, credentialId);
            return new Response(null, { status: 204 });
        }
        if (request.method === "POST" && pathname.endsWith("/pending-daemon-deliveries")) {
            await this.actor(access.runtimeId, access.scope).dispatchPending(request.signal);
            return new Response(null, { status: 204 });
        }
        if (request.method === "GET" && pathname.endsWith("/runtime-status")) {
            const current = this.currentConnection();
            return Response.json({
                online:
                    current?.state === "online" &&
                    current.runtimeId === access.runtimeId &&
                    this.#peers.daemons().length > 0,
            });
        }
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("WebSocket upgrade required", { status: 426 });
        }
        if (pathname.endsWith("/daemon")) {
            return await this.acceptDaemonSocket(
                access.runtimeId,
                access.scope,
                new URL(request.url).searchParams.get("liveness") === "1",
                request.signal,
            );
        }
        if (pathname.endsWith("/host")) {
            const credentialId = request.headers.get(INTERNAL_HOST_CREDENTIAL_ID_HEADER);
            if (credentialId === null) {
                return Response.json(
                    {
                        error: {
                            code: "unauthorized",
                            message: "Verified host credential access is required",
                        },
                    },
                    { status: 401 },
                );
            }
            return await this.acceptHostSocket(
                access.channelId,
                credentialId,
                access.runtimeId,
                access.scope,
                request.signal,
            );
        }
        return new Response(null, { status: 404 });
    }

    async webSocketMessage(socket: WebSocket, message: unknown): Promise<void> {
        const attachment = readAttachment(socket.deserializeAttachment());
        if (attachment.role === "host") {
            await this.withSocketSignal(socket, async (signal) => {
                const channelSocket = new CloudflareChannelSocket(socket);
                if (!(await this.isHostCredentialActive(attachment, signal))) {
                    channelSocket.close(1008, "Channel access revoked");
                    return;
                }
                const scope = new ProjectScope(attachment.tenantId, attachment.projectId);
                await this.actor(attachment.runtimeId, scope).receiveHostMessage(channelSocket, message, signal);
            });
            return;
        }
        // Liveness control traffic must not wait behind durable session writes.
        if (attachment.role === "daemon" && typeof message === "string") {
            try {
                if (decodeMessageKind(message) === RUNTIME_HEARTBEAT_KIND) {
                    if (!this.isCurrentConnection(attachment)) {
                        socket.serializeAttachment({
                            ...attachment,
                            role: "replaced-daemon",
                        });
                        socket.close(1012, "Daemon connection replaced");
                        return;
                    }
                    const heartbeat = decodeRuntimeHeartbeatEvent(message);
                    socket.send(
                        encodeRuntimeHeartbeatAckEvent({
                            heartbeatId: heartbeat.heartbeatId,
                            kind: RUNTIME_HEARTBEAT_ACK_KIND,
                        }),
                    );
                    return;
                }
            } catch {
                socket.close(1008, "Invalid protocol message");
                return;
            }
        }
        const operation = this.#daemonMessageTail.then(async () => {
            await this.withSocketSignal(socket, async (signal) => {
                const channelSocket = new CloudflareChannelSocket(socket);
                const scope = new ProjectScope(attachment.tenantId, attachment.projectId);
                if (attachment.role === "replaced-daemon") {
                    socket.close(1012, "Daemon connection replaced");
                    return;
                }
                if (!this.isCurrentConnection(attachment)) {
                    socket.serializeAttachment({
                        ...attachment,
                        role: "replaced-daemon",
                    });
                    socket.close(1012, "Daemon connection replaced");
                    return;
                }
                await this.actor(attachment.runtimeId, scope).receiveDaemonMessage(channelSocket, message, signal);
            });
        });
        this.#daemonMessageTail = operation.catch(() => undefined);
        await operation;
    }

    async webSocketClose(socket: WebSocket): Promise<void> {
        const attachment = readAttachment(socket.deserializeAttachment());
        if (attachment.role === "daemon") {
            await this.#daemonMessageTail;
            if (!this.isCurrentConnection(attachment)) {
                return;
            }
            this.#state.storage.sql.exec(
                `UPDATE runtime_connection_state
         SET state = 'offline', disconnected_at = ?
         WHERE singleton = 1 AND runtime_id = ? AND connection_epoch = ?
           AND connection_id = ?`,
                Date.now(),
                attachment.runtimeId,
                attachment.connectionEpoch,
                attachment.connectionId,
            );
            await this.actor(
                attachment.runtimeId,
                new ProjectScope(attachment.tenantId, attachment.projectId),
            ).detachDaemon(new CloudflareChannelSocket(socket), new AbortController().signal);
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
        const previousSockets = this.#state.getWebSockets(DAEMON_TAG).filter((socket) => {
            const attachment = readAttachment(socket.deserializeAttachment());
            return attachment.role === "daemon" && socket.readyState === WebSocket.OPEN;
        });
        const previous = this.currentConnection();
        if (previous !== null && previous.runtimeId !== runtimeId) {
            return Response.json(
                {
                    error: {
                        code: "runtime_identity_conflict",
                        message: "The Channel is already assigned to another Runtime",
                    },
                },
                { status: 409 },
            );
        }
        const connectionEpoch = (previous?.connectionEpoch ?? 0) + 1;
        const connectionId = `cnn_${crypto.randomUUID()}`;
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        for (const socket of previousSockets) {
            const attachment = readAttachment(socket.deserializeAttachment());
            socket.serializeAttachment({
                ...attachment,
                role: "replaced-daemon",
            });
            socket.close(1012, "Daemon connection replaced");
        }
        server.serializeAttachment({
            connectionEpoch,
            connectionId,
            projectId: scope.projectId,
            role: "daemon",
            runtimeId,
            tenantId: scope.tenantId,
        });
        this.#state.acceptWebSocket(server, [DAEMON_TAG]);
        this.#state.storage.sql.exec(
            `INSERT INTO runtime_connection_state (
         singleton, runtime_id, connection_epoch, connection_id, state,
         connected_at, disconnected_at
       ) VALUES (1, ?, ?, ?, 'online', ?, NULL)
       ON CONFLICT(singleton) DO UPDATE SET
         runtime_id = excluded.runtime_id,
         connection_epoch = excluded.connection_epoch,
         connection_id = excluded.connection_id,
         state = excluded.state,
         connected_at = excluded.connected_at,
         disconnected_at = NULL`,
            runtimeId,
            connectionEpoch,
            connectionId,
            Date.now(),
        );
        try {
            await this.actor(runtimeId, scope).attachDaemon(previousSockets.length > 0, signal);
        } catch (error) {
            server.close(1011, "Runtime attachment failed");
            throw error;
        }
        if (livenessRequested) {
            server.send(
                encodeRuntimeLivenessReadyEvent({
                    kind: RUNTIME_LIVENESS_READY_KIND,
                }),
            );
        }
        return new Response(null, { status: 101, webSocket: client });
    };

    private readonly acceptHostSocket = async (
        channelId: string,
        credentialId: string,
        runtimeId: string,
        scope: ProjectScope,
        signal: AbortSignal,
    ): Promise<Response> => {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        server.serializeAttachment({
            channelId,
            credentialId,
            projectId: scope.projectId,
            role: "host",
            runtimeId,
            tenantId: scope.tenantId,
        });
        this.#state.acceptWebSocket(server, [HOST_TAG]);
        await this.actor(runtimeId, scope).attachHost(new CloudflareChannelSocket(server), signal);
        return new Response(null, { status: 101, webSocket: client });
    };

    private readonly disconnectHostCredential = (
        access: ReturnType<typeof accessFromRequest>,
        credentialId: string,
    ): void => {
        for (const socket of this.#state.getWebSockets(HOST_TAG)) {
            const attachment = readAttachment(socket.deserializeAttachment());
            if (
                attachment.role === "host" &&
                attachment.channelId === access.channelId &&
                attachment.credentialId === credentialId &&
                attachment.runtimeId === access.runtimeId &&
                attachment.tenantId === access.scope.tenantId &&
                attachment.projectId === access.scope.projectId
            ) {
                socket.close(1008, "Channel access revoked");
            }
        }
    };

    private readonly isHostCredentialActive = async (
        attachment: Readonly<{
            readonly channelId: string;
            readonly credentialId: string;
            readonly projectId: string;
            readonly runtimeId: string;
            readonly tenantId: string;
        }>,
        signal: AbortSignal,
    ): Promise<boolean> => {
        signal.throwIfAborted();
        const row = await this.#database
            .prepare(
                `SELECT 1 AS active
         FROM channel_host_credentials AS credentials
         INNER JOIN pairing_channels AS channels
           ON channels.channel_id = credentials.channel_id
         WHERE credentials.credential_id = ?
           AND credentials.channel_id = ?
           AND credentials.revoked_at IS NULL
           AND channels.runtime_id = ?
           AND channels.tenant_id = ?
           AND channels.project_id = ?
           AND channels.status = 'paired'`,
            )
            .bind(
                attachment.credentialId,
                attachment.channelId,
                attachment.runtimeId,
                attachment.tenantId,
                attachment.projectId,
            )
            .first<{ readonly active: number }>();
        signal.throwIfAborted();
        return row?.active === 1;
    };

    private readonly currentConnection = (): CurrentRuntimeConnection | null => {
        const row = this.#state.storage.sql
            .exec(
                `SELECT runtime_id, connection_epoch, connection_id, state
         FROM runtime_connection_state WHERE singleton = 1`,
            )
            .toArray()[0];
        if (row === undefined) {
            return null;
        }
        const runtimeId = row["runtime_id"];
        const connectionEpoch = row["connection_epoch"];
        const connectionId = row["connection_id"];
        const state = row["state"];
        if (
            typeof runtimeId !== "string" ||
            typeof connectionEpoch !== "number" ||
            !Number.isSafeInteger(connectionEpoch) ||
            connectionEpoch < 1 ||
            typeof connectionId !== "string" ||
            (state !== "online" && state !== "offline")
        ) {
            throw new Error("The durable Runtime connection state is invalid");
        }
        return { connectionEpoch, connectionId, runtimeId, state };
    };

    private readonly isCurrentConnection = (
        attachment: Readonly<{
            connectionEpoch: number;
            connectionId: string;
            runtimeId: string;
        }>,
    ): boolean => {
        const current = this.currentConnection();
        return (
            current?.state === "online" &&
            current.runtimeId === attachment.runtimeId &&
            current.connectionEpoch === attachment.connectionEpoch &&
            current.connectionId === attachment.connectionId
        );
    };

    private readonly actor = (runtimeId: string, scope: ProjectScope): ChannelActor =>
        new ChannelActor({
            config: { runtimeId, scope },
            gateways: { commands: this.#sessions, queries: this.#sessions, peers: this.#peers },
        });

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
