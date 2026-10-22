import { isIdentifier, ProtocolMessageError } from "@moxt-ai/mobius-sdk/protocol";
import * as v from "valibot";
import type { ChannelSocket, HistoryRequestKind } from "../service/channel/channel-actor.ts";
import type {
    DaemonHeartbeat,
    RuntimePeers,
    RuntimeSocket,
    RuntimeSocketIdentity,
} from "../service/channel/runtime-service.ts";

// Four maximum-length routes fit alongside connection identity within the attachment budget.
const MAX_SETTINGS_DISCOVERY_ROUTES = 4;

const pendingAgentSettingsDiscoverySchema = v.object({
    agentId: v.pipe(v.string(), v.minLength(1)),
    requestId: v.pipe(v.string(), v.minLength(1)),
});
const historyRequestSchema = v.object({
    kind: v.picklist(["live", "preview"]),
    requestId: v.pipe(v.string(), v.minLength(1)),
});

const attachmentSchema = v.union([
    v.object({
        role: v.literal("viewer"),
        expiresAt: v.number(),
        eventFormat: v.picklist(["events", "envelope"]),
        projectId: v.string(),
        runtimeId: v.string(),
        sessionFilter: v.string(),
    }),
    v.object({
        role: v.literal("host"),
        channelId: v.string(),
        credentialId: v.string(),
        nativeRequestId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
        sessionFilter: v.optional(
            v.pipe(
                v.string(),
                v.check((value: string) => isIdentifier(value)),
            ),
        ),
        runtimeId: v.string(),
        projectId: v.string(),
        historyRequest: v.optional(historyRequestSchema),
        pendingAgentSettingsDiscoveries: v.optional(v.array(pendingAgentSettingsDiscoverySchema), []),
    }),
    v.object({
        role: v.literal("relay"),
        historyRequest: v.optional(historyRequestSchema),
        channelId: v.string(),
        runtimeId: v.string(),
        projectId: v.string(),
    }),
    v.object({
        role: v.picklist(["daemon", "replaced-daemon"]),
        connectionEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        connectionId: v.pipe(v.string(), v.minLength(1)),
        runtimeId: v.string(),
        projectId: v.string(),
        heartbeatAt: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    }),
]);

export class CloudflareChannelSocket implements RuntimeSocket {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        this.#socket = socket;
    }

    get sessionFilter(): string | undefined {
        const identity = this.identity();
        return identity.role === "host" || identity.role === "viewer" ? identity.sessionFilter : undefined;
    }

    readonly identity = (): RuntimeSocketIdentity => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (attachment.role === "host") {
            return {
                channelId: attachment.channelId,
                credentialId: attachment.credentialId,
                ...(attachment.nativeRequestId === undefined ? {} : { nativeRequestId: attachment.nativeRequestId }),
                ...(attachment.sessionFilter === undefined ? {} : { sessionFilter: attachment.sessionFilter }),
                projectId: attachment.projectId,
                role: attachment.role,
                runtimeId: attachment.runtimeId,
            };
        }
        if (attachment.role === "daemon" || attachment.role === "replaced-daemon") {
            return {
                connectionEpoch: attachment.connectionEpoch,
                connectionId: attachment.connectionId,
                projectId: attachment.projectId,
                role: attachment.role,
                runtimeId: attachment.runtimeId,
            };
        }
        return attachment;
    };
    readonly close = (code: number, reason: string): void => this.#socket.close(code, reason);
    readonly consumeAgentSettingsDiscovery = (requestId: string, agentId: string): boolean => {
        if (this.identity().role === "viewer") {
            return false;
        }
        const attachment = this.hostAttachment();
        let consumed = false;
        const pendingAgentSettingsDiscoveries = attachment.pendingAgentSettingsDiscoveries.filter((pending) => {
            if (pending.requestId === requestId && pending.agentId === agentId) {
                consumed = true;
                return false;
            }
            return true;
        });
        if (consumed || pendingAgentSettingsDiscoveries.length !== attachment.pendingAgentSettingsDiscoveries.length) {
            this.#socket.serializeAttachment({ ...attachment, pendingAgentSettingsDiscoveries });
        }
        return consumed;
    };
    readonly consumeAgentSettingsDiscoveryFailure = (requestId: string): boolean => {
        if (this.identity().role === "viewer") {
            return false;
        }
        const attachment = this.hostAttachment();
        let consumed = false;
        const pendingAgentSettingsDiscoveries = attachment.pendingAgentSettingsDiscoveries.filter((pending) => {
            if (pending.requestId === requestId) {
                consumed = true;
                return false;
            }
            return true;
        });
        if (consumed || pendingAgentSettingsDiscoveries.length !== attachment.pendingAgentSettingsDiscoveries.length) {
            this.#socket.serializeAttachment({ ...attachment, pendingAgentSettingsDiscoveries });
        }
        return consumed;
    };
    readonly takeAgentSettingsDiscoveries = (): readonly string[] => {
        if (this.identity().role === "viewer") {
            return [];
        }
        const attachment = this.hostAttachment();
        const requests = attachment.pendingAgentSettingsDiscoveries.map((pending) => pending.requestId);
        if (attachment.pendingAgentSettingsDiscoveries.length > 0) {
            this.#socket.serializeAttachment({ ...attachment, pendingAgentSettingsDiscoveries: [] });
        }
        return requests;
    };
    readonly bindHistoryRequest = (kind: HistoryRequestKind, requestId: string): void => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (!this.permitsSessionHistory()) {
            throw new ProtocolMessageError("History replies require an internal connection");
        }
        if (attachment.role === "host" || attachment.role === "relay") {
            if (
                attachment.historyRequest !== undefined &&
                (attachment.historyRequest.kind !== kind || attachment.historyRequest.requestId !== requestId)
            ) {
                throw new ProtocolMessageError("An internal history connection belongs to one request");
            }
            this.#socket.serializeAttachment({ ...attachment, historyRequest: { kind, requestId } });
            return;
        }
        throw new ProtocolMessageError("History replies require an internal connection");
    };
    readonly matchesHistoryRequest = (kind: HistoryRequestKind, requestId: string): boolean => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        return (
            (attachment.role === "host" || attachment.role === "relay") &&
            attachment.historyRequest?.kind === kind &&
            attachment.historyRequest.requestId === requestId
        );
    };
    readonly isOpen = (): boolean => this.#socket.readyState === WebSocket.OPEN;
    readonly isSame = (socket: ChannelSocket): boolean =>
        socket instanceof CloudflareChannelSocket && socket.#socket === this.#socket;
    readonly lastHeartbeat = (): DaemonHeartbeat => {
        const { heartbeatAt } = this.daemonAttachment();
        return heartbeatAt === undefined ? { kind: "none" } : { kind: "received", at: heartbeatAt };
    };
    readonly recordHeartbeat = (at: number): void => {
        this.#socket.serializeAttachment({ ...this.daemonAttachment(), heartbeatAt: at });
    };
    readonly permitsSessionHistory = (): boolean => {
        const identity = this.identity();
        return identity.role === "relay" || (identity.role === "host" && identity.credentialId.startsWith("ctl_"));
    };
    readonly send = (message: string): void => this.#socket.send(message);
    readonly trackAgentSettingsDiscovery = (requestId: string, agentId: string): "tracked" | "duplicate" | "busy" => {
        const attachment = this.hostAttachment();
        const existing = attachment.pendingAgentSettingsDiscoveries.find((pending) => pending.requestId === requestId);
        if (existing !== undefined) {
            return existing.agentId === agentId ? "duplicate" : "busy";
        }
        if (attachment.pendingAgentSettingsDiscoveries.length >= MAX_SETTINGS_DISCOVERY_ROUTES) {
            return "busy";
        }
        this.#socket.serializeAttachment({
            ...attachment,
            pendingAgentSettingsDiscoveries: [...attachment.pendingAgentSettingsDiscoveries, { agentId, requestId }],
        });
        return "tracked";
    };
    readonly replaceDaemon = (): void => {
        const identity = this.identity();
        if (identity.role !== "daemon" && identity.role !== "replaced-daemon") {
            throw new Error("Only a daemon socket can replace a daemon");
        }
        this.#socket.serializeAttachment({ ...identity, role: "replaced-daemon" });
        this.#socket.close(1012, "Daemon connection replaced");
    };

    private readonly daemonAttachment = () => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (attachment.role !== "daemon" && attachment.role !== "replaced-daemon") {
            throw new Error("Only a daemon socket carries heartbeats");
        }
        return attachment;
    };

    private readonly hostAttachment = () => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (attachment.role !== "host") {
            throw new Error("A Runtime socket cannot carry a Host control request");
        }
        return attachment;
    };
}

export class CloudflareChannelPeers implements RuntimePeers {
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState) {
        this.#state = state;
    }

    readonly sockets = () =>
        this.#state.getWebSockets().map((webSocket) => {
            const socket = new CloudflareChannelSocket(webSocket);
            return { socket, identity: socket.identity() };
        });

    readonly daemons = (): readonly ChannelSocket[] =>
        this.sockets()
            .filter(({ identity }) => identity.role === "daemon")
            .map(({ socket }) => socket);

    readonly hosts = (): readonly ChannelSocket[] =>
        this.#state.getWebSockets("host").map((socket) => new CloudflareChannelSocket(socket));

    readonly viewers = () =>
        this.sockets().flatMap(({ socket, identity }) =>
            identity.role === "viewer"
                ? [
                      {
                          socket,
                          sessionId: identity.sessionFilter,
                          expiresAt: identity.expiresAt,
                          eventFormat: identity.eventFormat,
                      },
                  ]
                : [],
        );

    readonly operations: RuntimePeers["operations"] = () => [];

    readonly nativeRequests = (): readonly { readonly requestId: string; readonly socket: ChannelSocket }[] =>
        this.#state.getWebSockets("native-request").map((webSocket) => {
            const socket = new CloudflareChannelSocket(webSocket);
            const identity = socket.identity();
            if (identity.role !== "host" || identity.nativeRequestId === undefined) {
                throw new Error("A native request connection requires a reply address");
            }
            return { requestId: identity.nativeRequestId, socket };
        });

    readonly historyRecipients = (): readonly ChannelSocket[] =>
        this.sockets()
            .filter(({ socket }) => socket.permitsSessionHistory())
            .map(({ socket }) => socket);

    readonly accept: RuntimePeers["accept"] = (identity) => {
        const pair = new WebSocketPair();
        const server = pair[1];
        server.serializeAttachment(identity);
        this.#state.acceptWebSocket(server, [
            identity.role === "host" && identity.nativeRequestId !== undefined ? "native-request" : identity.role,
        ]);
        return {
            socket: new CloudflareChannelSocket(server),
            response: new Response(null, { status: 101, webSocket: pair[0] }),
        };
    };
}
