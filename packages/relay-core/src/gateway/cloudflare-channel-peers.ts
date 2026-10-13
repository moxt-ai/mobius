import type { NativeSessionResult } from "@moxt-ai/mobius-protocol";
import * as v from "valibot";
import type { ChannelSocket, PendingNativeSessionImport } from "../service/channel/channel-actor.ts";
import type { RuntimePeers, RuntimeSocket, RuntimeSocketIdentity } from "../service/channel/runtime-service.ts";

const pendingAgentSettingsDiscoverySchema = v.object({
    agentId: v.pipe(v.string(), v.minLength(1)),
    expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    requestId: v.pipe(v.string(), v.minLength(1)),
});
const MAX_PENDING_NATIVE_IMPORTS = 4;
const pendingNativeImportSchema = v.object({
    fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    requestId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

// Keep correlation bounded even when the authorized directory ID is near its wire limit.
// A WebSocket attachment must remain below Cloudflare's 2 KiB limit.
async function nativeImportFingerprint(
    action: string,
    sessionId: string,
    agentId: string,
    directoryId: string,
): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([action, sessionId, agentId, directoryId])),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const attachmentSchema = v.union([
    v.object({
        role: v.literal("host"),
        channelId: v.string(),
        credentialId: v.string(),
        runtimeId: v.string(),
        projectId: v.string(),
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
        pendingNativeImports: v.optional(
            v.pipe(v.array(pendingNativeImportSchema), v.maxLength(MAX_PENDING_NATIVE_IMPORTS)),
            [],
        ),
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
        return identity.role === "relay" || (identity.role === "host" && identity.credentialId.startsWith("ctl_"));
    };
    readonly send = (message: string): void => this.#socket.send(message);
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
    readonly trackNativeSessionImport = async (request: PendingNativeSessionImport, now: number): Promise<boolean> => {
        const fingerprint = await nativeImportFingerprint(
            request.action,
            request.sessionId,
            request.agentId,
            request.directoryId,
        );
        const attachment = this.daemonAttachment();
        const pendingNativeImports = attachment.pendingNativeImports.filter((pending) => pending.expiresAt > now);
        if (
            pendingNativeImports.length >= MAX_PENDING_NATIVE_IMPORTS ||
            pendingNativeImports.some((pending) => pending.requestId === request.requestId)
        ) {
            return false;
        }
        this.#socket.serializeAttachment({
            ...attachment,
            pendingNativeImports: [
                ...pendingNativeImports,
                {
                    requestId: request.requestId,
                    expiresAt: request.expiresAt,
                    fingerprint,
                },
            ],
        });
        return true;
    };
    readonly consumeNativeSessionImport = async (
        result: Extract<NativeSessionResult, { readonly action: "import" | "fork" }>,
        now: number,
    ): Promise<boolean> => {
        const fingerprint = await nativeImportFingerprint(
            result.action,
            result.targetSessionId,
            result.ready.agentId,
            result.ready.directoryId,
        );
        const attachment = this.daemonAttachment();
        const pending = attachment.pendingNativeImports.find((request) => request.requestId === result.requestId);
        if (pending === undefined || pending.expiresAt <= now || pending.fingerprint !== fingerprint) {
            return false;
        }
        this.removeNativeSessionImport(result.requestId);
        return true;
    };
    readonly removeNativeSessionImport = (requestId: string): void => {
        const attachment = this.daemonAttachment();
        this.#socket.serializeAttachment({
            ...attachment,
            pendingNativeImports: attachment.pendingNativeImports.filter((pending) => pending.requestId !== requestId),
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

    private readonly daemonAttachment = () => {
        const attachment = v.parse(attachmentSchema, this.#socket.deserializeAttachment());
        if (attachment.role !== "daemon" && attachment.role !== "replaced-daemon") {
            throw new Error("Only a Runtime socket can carry a pending native import");
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
