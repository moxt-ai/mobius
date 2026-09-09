import type { ChannelSocket, RuntimePeers, RuntimeSocket, RuntimeSocketIdentity } from "@moxt-ai/mobius-relay-core";
import * as v from "valibot";

const attachmentSchema = v.union([
    v.object({
        role: v.literal("host"),
        channelId: v.string(),
        credentialId: v.string(),
        runtimeId: v.string(),
        tenantId: v.string(),
        projectId: v.string(),
    }),
    v.object({
        role: v.picklist(["daemon", "replaced-daemon"]),
        connectionEpoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        connectionId: v.pipe(v.string(), v.minLength(1)),
        runtimeId: v.string(),
        tenantId: v.string(),
        projectId: v.string(),
    }),
]);

export class CloudflareChannelSocket implements RuntimeSocket {
    readonly #socket: WebSocket;

    constructor(socket: WebSocket) {
        this.#socket = socket;
    }

    readonly identity = (): RuntimeSocketIdentity => v.parse(attachmentSchema, this.#socket.deserializeAttachment());
    readonly close = (code: number, reason: string): void => this.#socket.close(code, reason);
    readonly isOpen = (): boolean => this.#socket.readyState === WebSocket.OPEN;
    readonly isSame = (socket: ChannelSocket): boolean =>
        socket instanceof CloudflareChannelSocket && socket.#socket === this.#socket;
    readonly send = (message: string): void => this.#socket.send(message);
    readonly replaceDaemon = (): void => {
        const identity = this.identity();
        if (identity.role === "host") {
            throw new Error("A host socket cannot replace a daemon");
        }
        this.#socket.serializeAttachment({ ...identity, role: "replaced-daemon" });
        this.#socket.close(1012, "Daemon connection replaced");
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
