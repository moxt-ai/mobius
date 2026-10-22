import {
    type DaemonToServiceMessage,
    decodeDaemonToServiceMessage,
    encodeRuntimeStatusEvent,
    encodeServiceToDaemonMessage,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_STATUS_KIND,
    type RuntimeLivenessReadyEvent,
    SESSION_EVENT_KIND,
    UnsupportedProtocolMessageKindError,
} from "@moxt-ai/mobius-sdk/protocol";
import { ProjectScope } from "../../entity/do/session.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import { logger } from "../../infra/logger.ts";
import type { ChannelActor, ChannelPeers, ChannelSocket } from "./channel-actor.ts";
import type { ChannelCredentialService } from "./channel-credential-service.ts";
import type { RuntimeConnectionService } from "./runtime-connection-service.ts";
import { RuntimeMessageScheduler, RuntimeMessageSchedulerCapacityError } from "./runtime-message-scheduler.ts";

const DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS = 30_000;

const DAEMON_DETACH_TIMEOUT_MILLISECONDS = 30_000;

// A live daemon heartbeats every 20 seconds and abandons a connection whose acknowledgement takes
// longer than 10 seconds. A daemon silent past both, plus delivery slack, has lost this connection
// even though the Relay never saw it close, so commands sent into it would never be answered.
const DAEMON_HEARTBEAT_SILENCE_LIMIT_MILLISECONDS = 35_000;

/** Whether a daemon connection has proven its liveness with a heartbeat, and when it last did. */
export type DaemonHeartbeat = { readonly kind: "none" } | { readonly kind: "received"; readonly at: number };

export type RuntimeSocketIdentity =
    | {
          readonly role: "viewer";
          readonly expiresAt: number;
          readonly eventFormat: "events" | "envelope";
          readonly projectId: string;
          readonly runtimeId: string;
          readonly sessionFilter: string;
      }
    | {
          readonly role: "relay";
          readonly channelId: string;
          readonly runtimeId: string;
          readonly projectId: string;
      }
    | {
          readonly role: "host";
          readonly channelId: string;
          readonly credentialId: string;
          readonly nativeRequestId?: string;
          readonly sessionFilter?: string;
          readonly runtimeId: string;
          readonly projectId: string;
      }
    | {
          readonly role: "daemon" | "replaced-daemon";
          readonly connectionEpoch: number;
          readonly connectionId: string;
          readonly runtimeId: string;
          readonly projectId: string;
      };

export interface RuntimeSocket extends ChannelSocket {
    readonly lastHeartbeat: () => DaemonHeartbeat;
    readonly recordHeartbeat: (at: number) => void;
    readonly replaceDaemon: () => void;
}

export interface RuntimePeers extends ChannelPeers {
    readonly sockets: () => readonly { readonly identity: RuntimeSocketIdentity; readonly socket: RuntimeSocket }[];
    readonly accept: (identity: RuntimeSocketIdentity) => {
        readonly socket: RuntimeSocket;
        readonly response: Response;
    };
}

type RuntimePeer = ReturnType<RuntimePeers["sockets"]>[number];

interface RuntimeContext {
    readonly services: {
        readonly connections: RuntimeConnectionService;
        readonly credentials: Pick<ChannelCredentialService, "isActive">;
        readonly channel: (runtimeId: string, scope: ProjectScope) => ChannelActor;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}

type RuntimeAcceptance =
    | { readonly kind: "conflict" }
    | { readonly kind: "revoked" }
    | { readonly kind: "accepted"; readonly response: Response };

type DaemonSocketIdentity = Extract<RuntimeSocketIdentity, { readonly role: "daemon" | "replaced-daemon" }> & {
    readonly role: "daemon";
};

export class RuntimeService {
    readonly #cx: RuntimeContext;
    readonly #channels = new Map<string, ChannelActor>();
    readonly #daemonMessages = new RuntimeMessageScheduler();
    readonly #attachments = new Set<{
        readonly controller: AbortController;
        readonly identity: DaemonSocketIdentity;
    }>();
    #acceptTail: Promise<void> = Promise.resolve();
    readonly #accepting = new Set<{
        readonly runtimeId: string;
        readonly scope: ProjectScope;
        readonly controller: AbortController;
    }>();

    constructor(cx: RuntimeContext) {
        this.#cx = cx;
    }

    readonly acceptDaemon = async (runtimeId: string, scope: ProjectScope, liveness: boolean, signal: AbortSignal) => {
        const accepting = { runtimeId, scope, controller: new AbortController() };
        this.#accepting.add(accepting);
        const operation = this.#acceptTail.then(async (): Promise<RuntimeAcceptance> => {
            try {
                return await this.acceptDaemonSocket(
                    runtimeId,
                    scope,
                    liveness,
                    AbortSignal.any([signal, accepting.controller.signal]),
                );
            } catch (error) {
                signal.throwIfAborted();
                if (this.isRevoked(runtimeId, scope)) {
                    return { kind: "revoked" };
                }
                throw error;
            }
        });
        this.#acceptTail = operation.then(
            () => undefined,
            () => undefined,
        );
        try {
            return await operation;
        } finally {
            this.#accepting.delete(accepting);
        }
    };

    readonly isRevoked = (runtimeId: string, scope: ProjectScope): boolean =>
        this.#cx.services.connections.isRevoked(runtimeId, scope);

    private readonly acceptDaemonSocket = async (
        runtimeId: string,
        scope: ProjectScope,
        liveness: boolean,
        signal: AbortSignal,
    ): Promise<RuntimeAcceptance> => {
        signal.throwIfAborted();
        if (this.isRevoked(runtimeId, scope)) {
            return { kind: "revoked" };
        }
        const current = this.#cx.services.connections.current();
        if (current !== null && current.runtimeId !== runtimeId) {
            return { kind: "conflict" };
        }
        const previous = this.#cx.gateways.peers
            .sockets()
            .filter(({ identity, socket }) => identity.role === "daemon" && socket.isOpen());
        for (const attachment of this.#attachments) {
            if (attachment.identity.runtimeId === runtimeId && attachment.identity.projectId === scope.projectId) {
                attachment.controller.abort(new DOMException("Runtime connection replaced", "AbortError"));
            }
        }
        for (const { socket } of previous) {
            socket.replaceDaemon();
        }
        signal.throwIfAborted();
        // No await may separate this durable revocation check from accept + connect.
        const prepared = this.#cx.services.connections.prepare(runtimeId, scope);
        if (prepared.kind !== "ready") {
            return prepared;
        }
        const identity: DaemonSocketIdentity = {
            ...prepared.identity,
            role: "daemon",
            projectId: scope.projectId,
        };
        const accepted = this.#cx.gateways.peers.accept(identity);
        this.#cx.services.connections.connected(prepared.identity, Date.now());
        logger.info({ ...identity, event: "runtime_websocket_accepted" }, "Runtime WebSocket accepted");
        if (liveness) {
            this.deferDaemonAttachment(identity, accepted.socket, scope, previous.length > 0);
            return { kind: "accepted", response: accepted.response };
        }
        try {
            await this.attachDaemon(runtimeId, scope, previous.length > 0, signal);
        } catch (error) {
            accepted.socket.close(1011, "Runtime attachment failed");
            throw error;
        }
        if (this.isRevoked(runtimeId, scope)) {
            accepted.socket.close(1008, "Runtime revoked");
            return { kind: "revoked" };
        }
        signal.throwIfAborted();
        return { kind: "accepted", response: accepted.response };
    };

    private readonly deferDaemonAttachment = (
        identity: DaemonSocketIdentity,
        socket: RuntimeSocket,
        scope: ProjectScope,
        replaced: boolean,
    ): void => {
        const attachment = { controller: new AbortController(), identity };
        this.#attachments.add(attachment);
        const signal = AbortSignal.any([
            attachment.controller.signal,
            AbortSignal.timeout(DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS),
        ]);
        const operation = (async () => {
            try {
                await this.attachDaemon(identity.runtimeId, scope, replaced, signal);
                signal.throwIfAborted();
                if (!this.#cx.services.connections.isCurrent(identity)) {
                    return;
                }
                if (this.isRevoked(identity.runtimeId, scope)) {
                    socket.close(1008, "Runtime revoked");
                    return;
                }
                const ready: RuntimeLivenessReadyEvent = { kind: RUNTIME_LIVENESS_READY_KIND };
                socket.send(encodeServiceToDaemonMessage(ready));
            } catch (error) {
                if (!attachment.controller.signal.aborted) {
                    logger.error(
                        { ...identity, err: error, event: "runtime_attachment_failed" },
                        "Runtime attachment failed",
                    );
                }
                if (this.#cx.services.connections.isCurrent(identity)) {
                    socket.close(1011, "Runtime attachment failed");
                }
            } finally {
                this.#attachments.delete(attachment);
            }
        })();
        this.#cx.utilities.waitUntil(operation);
    };

    readonly acceptHost = async (
        identity: Extract<RuntimeSocketIdentity, { readonly role: "host" }>,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        const accepted = this.#cx.gateways.peers.accept(identity);
        await this.attachHost(identity.runtimeId, new ProjectScope(identity.projectId), accepted.socket, signal);
        return accepted.response;
    };

    readonly acceptRelay = async (
        identity: Extract<RuntimeSocketIdentity, { readonly role: "relay" }>,
        signal: AbortSignal,
    ): Promise<Response> => {
        signal.throwIfAborted();
        const accepted = this.#cx.gateways.peers.accept(identity);
        await this.attachHost(identity.runtimeId, new ProjectScope(identity.projectId), accepted.socket, signal);
        return accepted.response;
    };

    readonly revokeHost = (channelId: string, credentialId: string, runtimeId: string, scope: ProjectScope): void => {
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (
                identity.role === "host" &&
                identity.channelId === channelId &&
                identity.credentialId === credentialId &&
                identity.runtimeId === runtimeId &&
                identity.projectId === scope.projectId
            ) {
                socket.close(1008, "Channel access revoked");
            }
        }
    };

    readonly revokeRuntime = async (
        channelId: string,
        runtimeId: string,
        scope: ProjectScope,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        this.#cx.services.connections.revoke(runtimeId, scope, Date.now());
        for (const accepting of this.#accepting) {
            if (accepting.runtimeId === runtimeId && accepting.scope.projectId === scope.projectId) {
                accepting.controller.abort(new DOMException("Runtime revoked", "AbortError"));
            }
        }
        for (const attachment of this.#attachments) {
            if (attachment.identity.runtimeId === runtimeId && attachment.identity.projectId === scope.projectId) {
                attachment.controller.abort(new DOMException("Runtime revoked", "AbortError"));
            }
        }
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (identity.runtimeId !== runtimeId || identity.projectId !== scope.projectId) {
                continue;
            }
            if (identity.role === "daemon") {
                socket.close(1008, "Runtime revoked");
            } else if (identity.role === "viewer" || (identity.role === "host" && identity.channelId === channelId)) {
                socket.close(1008, "Runtime revoked");
            }
        }
        const current = this.#cx.services.connections.current();
        if (current !== null && current.runtimeId === runtimeId) {
            this.#cx.services.connections.disconnected(current, Date.now());
            this.notifyOffline(runtimeId);
        }
    };

    /** Closes daemon connections that stopped heartbeating, so presence reads report them offline. */
    readonly expireSilentDaemons = async (): Promise<void> => {
        await this.detachDaemons(this.closeSilentDaemons());
    };

    readonly isOnline = (runtimeId: string): boolean => {
        const current = this.#cx.services.connections.current();
        return (
            current?.state === "online" &&
            current.runtimeId === runtimeId &&
            this.#cx.gateways.peers.daemons().length > 0
        );
    };

    readonly attachDaemon = async (
        runtimeId: string,
        scope: ProjectScope,
        replaced: boolean,
        signal: AbortSignal,
    ): Promise<void> => {
        const channel = this.channel(runtimeId, scope);
        await channel.attachDaemon(replaced, signal);
    };

    readonly attachHost = (runtimeId: string, scope: ProjectScope, socket: ChannelSocket, signal: AbortSignal) =>
        this.channel(runtimeId, scope).attachHost(socket, signal);

    /** The public HTTP handler already authorized this operation; no host credential is involved. */
    readonly receiveOperation = async (
        scope: ProjectScope,
        runtimeId: string,
        socket: ChannelSocket,
        message: string,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const silent = this.closeSilentDaemons();
        try {
            const daemon = this.#cx.gateways.peers
                .sockets()
                .find(
                    ({ identity, socket: peer }) =>
                        identity.role === "daemon" &&
                        peer.isOpen() &&
                        this.#cx.services.connections.isCurrent(identity),
                );
            if (
                daemon !== undefined &&
                (daemon.identity.projectId !== scope.projectId || daemon.identity.runtimeId !== runtimeId)
            ) {
                throw new PairingDirectoryError("runtime_access_denied", "The selected Runtime is unavailable");
            }
            await this.channel(runtimeId, scope).receiveHostMessage(socket, message, signal);
        } finally {
            await this.detachDaemons(silent);
        }
    };

    readonly receiveMessage = async (
        identity: RuntimeSocketIdentity,
        socket: RuntimeSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const scope = new ProjectScope(identity.projectId);
        if (identity.role === "host" || identity.role === "relay" || identity.role === "viewer") {
            // Closing first makes this command see the Runtime as offline and fail at once; detaching
            // afterwards releases commands already sent into the silent connection.
            const silentDaemons = this.closeSilentDaemons();
            try {
                if (identity.role === "relay") {
                    const channel = this.channel(identity.runtimeId, scope);
                    await channel.receiveHostMessage(socket, message, signal);
                    return;
                }
                if (identity.role === "viewer") {
                    socket.close(1008, "A live subscription cannot send commands");
                    return;
                }
                if (!(await this.#cx.services.credentials.isActive(identity, signal))) {
                    socket.close(1008, "Channel access revoked");
                    return;
                }
                const channel = this.channel(identity.runtimeId, scope);
                await channel.receiveHostMessage(socket, message, signal);
                return;
            } finally {
                await this.detachDaemons(silentDaemons);
            }
        }
        if (typeof message !== "string" || message.length > 8 * 1024 * 1024) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        let daemonMessage: DaemonToServiceMessage;
        try {
            daemonMessage = decodeDaemonToServiceMessage(message);
        } catch (cause) {
            if (cause instanceof UnsupportedProtocolMessageKindError) {
                console.warn("Runtime message skipped", {
                    code: cause.code,
                    direction: cause.direction,
                    messageKind: cause.messageKind,
                });
                return;
            }
            socket.close(1008, "Invalid protocol message");
            return;
        }
        // Heartbeats must bypass application message scheduling.
        if (identity.role === "daemon" && daemonMessage.kind === RUNTIME_HEARTBEAT_KIND) {
            if (!this.#cx.services.connections.isCurrent(identity)) {
                socket.replaceDaemon();
                return;
            }
            socket.recordHeartbeat(Date.now());
            socket.send(
                encodeServiceToDaemonMessage({
                    heartbeatId: daemonMessage.heartbeatId,
                    kind: RUNTIME_HEARTBEAT_ACK_KIND,
                }),
            );
            return;
        }
        const lane = this.daemonMessageLane(daemonMessage);
        try {
            await this.#daemonMessages.run(lane, signal, async () => {
                signal.throwIfAborted();
                if (identity.role === "replaced-daemon") {
                    socket.close(1012, "Daemon connection replaced");
                    return;
                }
                if (!this.#cx.services.connections.isCurrent(identity)) {
                    socket.replaceDaemon();
                    return;
                }
                const channel = this.channel(identity.runtimeId, scope);
                await channel.receiveDaemonMessage(socket, daemonMessage, signal);
            });
        } catch (error) {
            if (error instanceof RuntimeMessageSchedulerCapacityError) {
                logger.warn(
                    { ...identity, err: error, event: "runtime_message_queue_full", closeCode: 1013 },
                    "Runtime message queue full",
                );
                socket.close(1013, error.code);
                return;
            }
            throw error;
        }
    };

    private readonly daemonMessageLane = (message: DaemonToServiceMessage): string => {
        if (message.kind === SESSION_EVENT_KIND) {
            return message.events.every((event) => event.sessionId === message.events[0]?.sessionId)
                ? `session:${message.events[0]?.sessionId ?? "unknown"}`
                : "runtime";
        }
        return "runtime";
    };

    private readonly channel = (runtimeId: string, scope: ProjectScope): ChannelActor => {
        const key = JSON.stringify({
            projectId: scope.projectId,
            runtimeId,
        });
        const existing = this.#channels.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const channel = this.#cx.services.channel(runtimeId, scope);
        this.#channels.set(key, channel);
        return channel;
    };

    readonly detach = async (
        identity: RuntimeSocketIdentity,
        socket: ChannelSocket,
        signal: AbortSignal,
    ): Promise<void> => {
        if (identity.role !== "daemon" || !this.#cx.services.connections.isCurrent(identity)) {
            return;
        }
        for (const attachment of this.#attachments) {
            if (
                attachment.identity.connectionId === identity.connectionId &&
                attachment.identity.connectionEpoch === identity.connectionEpoch
            ) {
                attachment.controller.abort(new DOMException("Runtime connection closed", "AbortError"));
            }
        }
        await this.#daemonMessages.idle(signal);
        if (!this.#cx.services.connections.isCurrent(identity)) {
            return;
        }
        this.#cx.services.connections.disconnected(identity, Date.now());
        await this.channel(identity.runtimeId, new ProjectScope(identity.projectId)).detachDaemon(socket, signal);
    };

    private readonly closeSilentDaemons = (): readonly RuntimePeer[] => {
        const now = Date.now();
        const silent: RuntimePeer[] = [];
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (identity.role !== "daemon" || !socket.isOpen()) {
                continue;
            }
            // A daemon that never heartbeated predates liveness or has just connected; only the
            // connection's own close tells the Relay it has gone.
            const heartbeat = socket.lastHeartbeat();
            if (heartbeat.kind === "none" || now - heartbeat.at <= DAEMON_HEARTBEAT_SILENCE_LIMIT_MILLISECONDS) {
                continue;
            }
            logger.warn(
                {
                    ...identity,
                    closeCode: 4001,
                    event: "runtime_heartbeat_silence",
                    silenceMilliseconds: now - heartbeat.at,
                },
                "Runtime daemon stopped heartbeating",
            );
            socket.close(4001, "Runtime heartbeat timed out");
            silent.push({ identity, socket });
        }
        return silent;
    };

    // The connection may never report its close, so the Relay detaches it itself. The command or
    // read that noticed the silence may end first, so the detach does not share its cancellation.
    private readonly detachDaemons = async (daemons: readonly RuntimePeer[]): Promise<void> => {
        for (const { identity, socket } of daemons) {
            await this.detach(identity, socket, AbortSignal.timeout(DAEMON_DETACH_TIMEOUT_MILLISECONDS));
        }
    };

    private readonly notifyOffline = (runtimeId: string): void => {
        for (const host of [
            ...this.#cx.gateways.peers.hosts(),
            ...this.#cx.gateways.peers.operations().map(({ socket }) => socket),
            ...this.#cx.gateways.peers.nativeRequests().map(({ socket }) => socket),
        ]) {
            if (host.isOpen()) {
                host.send(encodeRuntimeStatusEvent({ kind: RUNTIME_STATUS_KIND, runtimeId, online: false }));
            }
        }
    };
}
