import * as v from "valibot";
import type { ChannelSocket } from "../service/channel/channel-actor.ts";
import type { RuntimePeers, RuntimeSocket, RuntimeSocketIdentity } from "../service/channel/runtime-service.ts";

const pendingAgentCatalogRefreshSchema = v.object({
    expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    requestId: v.pipe(v.string(), v.minLength(1)),
});
const pendingAgentSettingsDiscoverySchema = v.object({
    agentId: v.pipe(v.string(), v.minLength(1)),
    expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    requestId: v.pipe(v.string(), v.minLength(1)),
});
const attachmentSchema = v.union([
    v.object({
        role: v.literal("host"),
        channelId: v.string(),
        credentialId: v.string(),
        runtimeId: v.string(),
        projectId: v.string(),
        pendingAgentCatalogRefreshes: v.optional(v.array(pendingAgentCatalogRefreshSchema), []),
        pendingAgentSettingsDiscoveries: v.optional(v.array(pendingAgentSettingsDiscoverySchema), []),
    }),
    v.object({
        role: v.literal("relay"),
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
    }),
]);

export class CloudflareChannelSocket implements RuntimeSocket {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        this.#socket = socket;
    }

    readonly identity = (): RuntimeSocketIdentity => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (attachment.role === "host") {
            return {
                channelId: attachment.channelId,
                credentialId: attachment.credentialId,
                projectId: attachment.projectId,
                role: attachment.role,
                runtimeId: attachment.runtimeId,
            };
        }
        return attachment;
    };
    readonly close = (code: number, reason: string): void => this.#socket.close(code, reason);
    readonly consumeAgentCatalogRefresh = (requestId: string, now: number): boolean => {
        const attachment = this.hostAttachment();
        let consumed = false;
        const pendingAgentCatalogRefreshes = attachment.pendingAgentCatalogRefreshes.filter((pending) => {
            if (pending.expiresAt <= now) {
                return false;
            }
            if (pending.requestId === requestId) {
                consumed = true;
                return false;
            }
            return true;
        });
        if (consumed || pendingAgentCatalogRefreshes.length !== attachment.pendingAgentCatalogRefreshes.length) {
            this.#socket.serializeAttachment({ ...attachment, pendingAgentCatalogRefreshes });
        }
        return consumed;
    };
    readonly consumeAgentSettingsDiscovery = (requestId: string, agentId: string, now: number): boolean => {
        const attachment = this.hostAttachment();
        let consumed = false;
        const pendingAgentSettingsDiscoveries = attachment.pendingAgentSettingsDiscoveries.filter((pending) => {
            if (pending.expiresAt <= now) {
                return false;
            }
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
    readonly consumeAgentSettingsDiscoveryFailure = (requestId: string, now: number): boolean => {
        const attachment = this.hostAttachment();
        let consumed = false;
        const pendingAgentSettingsDiscoveries = attachment.pendingAgentSettingsDiscoveries.filter((pending) => {
            if (pending.expiresAt <= now) {
                return false;
            }
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
    readonly isOpen = (): boolean => this.#socket.readyState === WebSocket.OPEN;
    readonly isSame = (socket: ChannelSocket): boolean =>
        socket instanceof CloudflareChannelSocket && socket.#socket === this.#socket;
    readonly permitsLiveSessionHistory = (): boolean => {
        const identity = this.identity();
        return identity.role === "relay";
    };
    readonly send = (message: string): void => this.#socket.send(message);
    readonly trackAgentCatalogRefresh = (requestId: string, expiresAt: number): void => {
        const attachment = this.hostAttachment();
        this.#socket.serializeAttachment({
            ...attachment,
            pendingAgentCatalogRefreshes: [
                ...attachment.pendingAgentCatalogRefreshes.filter((pending) => pending.expiresAt > Date.now()),
                { expiresAt, requestId },
            ],
        });
    };
    readonly trackAgentSettingsDiscovery = (requestId: string, agentId: string, expiresAt: number): void => {
        const attachment = this.hostAttachment();
        this.#socket.serializeAttachment({
            ...attachment,
            pendingAgentSettingsDiscoveries: [
                ...attachment.pendingAgentSettingsDiscoveries.filter((pending) => pending.expiresAt > Date.now()),
                { agentId, expiresAt, requestId },
            ],
        });
    };
    readonly replaceDaemon = (): void => {
        const identity = this.identity();
        if (identity.role !== "daemon" && identity.role !== "replaced-daemon") {
            throw new Error("Only a daemon socket can replace a daemon");
        }
        this.#socket.serializeAttachment({ ...identity, role: "replaced-daemon" });
        this.#socket.close(1012, "Daemon connection replaced");
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

    readonly accept: RuntimePeers["accept"] = (identity) => {
        const pair = new WebSocketPair();
        const server = pair[1];
        server.serializeAttachment(identity);
        this.#state.acceptWebSocket(server, [identity.role]);
        return {
            socket: new CloudflareChannelSocket(server),
            response: new Response(null, { status: 101, webSocket: pair[0] }),
        };
    };
}
