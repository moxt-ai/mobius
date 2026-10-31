import {
    type DaemonToRelayMessage,
    decodeDaemonToRelayMessage,
    encodeRuntimeStatusEvent,
    encodeServiceToDaemonMessage,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_STATUS_KIND,
    type RuntimeLivenessReadyEvent,
    SESSION_EVENT_KIND,
} from "@moxt-ai/mobius-sdk/protocol";
import { ProjectScope } from "../../entity/do/session.ts";
import { type HostCredential, PairingDirectoryError } from "../../entity/pairing/pairing.ts";
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

/** Whether a heartbeat on a daemon connection has been answered, and when it last was. */
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
          readonly credential: HostCredential;
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
    readonly replaceDaemon: () => void;
}

export interface RuntimePeers extends ChannelPeers {
    readonly sockets: () => readonly { readonly identity: RuntimeSocketIdentity; readonly socket: RuntimeSocket }[];
    /** Daemon connections with the time each one's heartbeat was last answered by the host. */
    readonly daemonConnections: () => readonly {
        readonly identity: RuntimeSocketIdentity;
        readonly socket: RuntimeSocket;
        readonly heartbeat: DaemonHeartbeat;
    }[];
    readonly accept: (identity: RuntimeSocketIdentity) => {
        readonly socket: RuntimeSocket;
        readonly response: Response;
    };
}

type RuntimePeer = ReturnType<RuntimePeers["sockets"]>[number];

interface RuntimeContext {
    readonly services: {
        readonly connections: RuntimeConnectionService;
        readonly credentials: {
            readonly isRuntimeActive: ChannelCredentialService["isRuntimeActive"];
            /** Whether the credential that opened a host connection still authorizes it. */
            readonly isHostActive: (
                identity: Extract<RuntimeSocketIdentity, { readonly role: "host" }>,
                signal: AbortSignal,
            ) => Promise<boolean>;
        };
        readonly channel: (runtimeId: string, scope: ProjectScope) => ChannelActor;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
    };
    readonly utilities: {
        readonly waitUntil: (operation: Promise<void>) => void;
    };
}

export type RuntimeCredentials = RuntimeContext["services"]["credentials"];

export type RuntimeAdmission =
    | { readonly kind: "revoked" }
    | { readonly kind: "accepted"; readonly response: Response };

type RuntimeAcceptance = RuntimeAdmission | { readonly kind: "conflict" };

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

    readonly acceptDaemon = (runtimeId: string, scope: ProjectScope, signal: AbortSignal) =>
        this.admit(runtimeId, scope, signal, (admission) => {
            const operation = this.#acceptTail.then(() => this.acceptDaemonSocket(runtimeId, scope, admission));
            this.#acceptTail = operation.then(
                () => undefined,
                () => undefined,
            );
            return operation;
        });

    /**
     * Admits a connection only while the Project serves this Runtime and has not revoked it. The pending
     * admission is registered before that authority is read: a revocation committed after the read is notified
     * after it, and the notification aborts the admission. `accept` must check the admission signal and then
     * accept without awaiting, so a later notification finds the accepted socket and closes it.
     */
    private readonly admit = async <T>(
        runtimeId: string,
        scope: ProjectScope,
        signal: AbortSignal,
        accept: (admission: AbortSignal) => Promise<T>,
    ): Promise<T | { readonly kind: "revoked" }> => {
        const pending = { runtimeId, scope, controller: new AbortController() };
        this.#accepting.add(pending);
        try {
            const admission = AbortSignal.any([signal, pending.controller.signal]);
            const runtime = { projectId: scope.projectId, runtimeId };
            if (!(await this.#cx.services.credentials.isRuntimeActive(runtime, admission))) {
                return { kind: "revoked" };
            }
            return await accept(admission);
        } catch (error) {
            signal.throwIfAborted();
            if (pending.controller.signal.aborted) {
                return { kind: "revoked" };
            }
            throw error;
        } finally {
            this.#accepting.delete(pending);
        }
    };

    private readonly acceptDaemonSocket = (
        runtimeId: string,
        scope: ProjectScope,
        signal: AbortSignal,
    ): RuntimeAcceptance => {
        // Nothing below awaits, so this admission check and accept + connect are one step.
        signal.throwIfAborted();
        const prepared = this.#cx.services.connections.prepare(runtimeId);
        if (prepared.kind === "conflict") {
            return prepared;
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
        const identity: DaemonSocketIdentity = {
            ...prepared.identity,
            role: "daemon",
            projectId: scope.projectId,
        };
        const accepted = this.#cx.gateways.peers.accept(identity);
        this.#cx.services.connections.connected(prepared.identity, Date.now());
        logger.info({ ...identity, event: "runtime_websocket_accepted" }, "Runtime WebSocket accepted");
        this.deferDaemonAttachment(identity, accepted.socket, scope, previous.length > 0);
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
        // An uncancellable AbortSignal.timeout would keep this Durable Object awake for the whole deadline
        // after the attachment finished, so the timer is cleared once it settles.
        const timeout = new AbortController();
        const timer = setTimeout(
            () => timeout.abort(new DOMException("The Runtime attachment timed out", "TimeoutError")),
            DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS,
        );
        const signal = AbortSignal.any([attachment.controller.signal, timeout.signal]);
        const operation = (async () => {
            try {
                await this.attachDaemon(identity.runtimeId, scope, replaced, signal);
                signal.throwIfAborted();
                if (!this.#cx.services.connections.isCurrent(identity)) {
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
                clearTimeout(timer);
                this.#attachments.delete(attachment);
            }
        })();
        this.#cx.utilities.waitUntil(operation);
    };

    readonly acceptHost = (
        identity: Extract<RuntimeSocketIdentity, { readonly role: "host" | "relay" }>,
        signal: AbortSignal,
    ): Promise<RuntimeAdmission> => {
        const scope = new ProjectScope(identity.projectId);
        return this.admit(identity.runtimeId, scope, signal, async (admission): Promise<RuntimeAdmission> => {
            admission.throwIfAborted();
            const accepted = this.#cx.gateways.peers.accept(identity);
            await this.attachHost(identity.runtimeId, scope, accepted.socket, signal);
            return { kind: "accepted", response: accepted.response };
        });
    };

    readonly revokeHost = (channelId: string, credentialId: string, runtimeId: string, scope: ProjectScope): void => {
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (
                identity.role === "host" &&
                identity.channelId === channelId &&
                identity.credential.kind === "channel" &&
                identity.credential.credentialId === credentialId &&
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
        // The Project's Runtime authority committed the revocation before notifying; acceptance and every
        // daemon message read that authority, so this notification only cleans up promptly. Its one fallible
        // step runs first, so a failed notification leaves this Relay unchanged for the caller to retry.
        const current = this.#cx.services.connections.current();
        const connected = current !== null && current.runtimeId === runtimeId;
        if (connected) {
            this.#cx.services.connections.disconnected(current, Date.now());
        }
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
        if (connected) {
            this.notifyOffline(runtimeId);
        }
    };

    /** Closes daemon connections that stopped heartbeating or were superseded, so presence reads report them offline. */
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
        message: unknown,
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
            const channel = this.channel(runtimeId, scope);
            if (typeof message === "string") {
                await channel.receiveHostMessage(socket, message, signal);
            } else {
                channel.receiveHostChunk(socket, message);
            }
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
                    if (typeof message !== "string") {
                        channel.receiveHostChunk(socket, message);
                        return;
                    }
                    await channel.receiveHostMessage(socket, message, signal);
                    return;
                }
                if (identity.role === "viewer") {
                    socket.close(1008, "A live subscription cannot send commands");
                    return;
                }
                if (!(await this.#cx.services.credentials.isHostActive(identity, signal))) {
                    socket.close(1008, "Channel access revoked");
                    return;
                }
                const channel = this.channel(identity.runtimeId, scope);
                if (typeof message !== "string") {
                    channel.receiveHostChunk(socket, message);
                    return;
                }
                await channel.receiveHostMessage(socket, message, signal);
                return;
            } finally {
                await this.detachDaemons(silentDaemons);
            }
        }
        if (typeof message !== "string") {
            try {
                await this.#daemonMessages.run(["runtime"], signal, async () => {
                    signal.throwIfAborted();
                    if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                        return;
                    }
                    this.channel(identity.runtimeId, scope).receiveDaemonChunk(socket, message);
                });
            } catch (error) {
                signal.throwIfAborted();
                socket.close(
                    error instanceof RuntimeMessageSchedulerCapacityError ? 1013 : 1008,
                    "Invalid content chunk",
                );
            }
            return;
        }
        if (message.length > 8 * 1024 * 1024) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        let daemonMessage: DaemonToRelayMessage | null;
        try {
            daemonMessage = decodeDaemonToRelayMessage(message);
        } catch {
            // Reject this frame without disconnecting unrelated Sessions.
            this.channel(identity.runtimeId, scope).recordSkipped("invalid_daemon_message");
            return;
        }
        const lanes = daemonMessage === null ? ["runtime"] : this.daemonMessageLanes(daemonMessage);
        try {
            await this.#daemonMessages.run(lanes, signal, async () => {
                signal.throwIfAborted();
                if (!(await this.authorizeDaemonMessage(identity, socket, signal))) {
                    return;
                }
                const channel = this.channel(identity.runtimeId, scope);
                await channel.receiveDaemonMessage(socket, daemonMessage, signal, message);
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

    private readonly authorizeDaemonMessage = async (
        identity: Extract<RuntimeSocketIdentity, { readonly role: "daemon" | "replaced-daemon" }>,
        socket: RuntimeSocket,
        signal: AbortSignal,
    ): Promise<boolean> => {
        if (identity.role === "replaced-daemon") {
            socket.close(1012, "Daemon connection replaced");
            return false;
        }
        if (!this.#cx.services.connections.isCurrent(identity)) {
            socket.replaceDaemon();
            return false;
        }
        // Disconnect delivery can fail after revocation commits in Project storage. Read that
        // authority before every business message; the local connection fence alone is insufficient.
        try {
            if (!(await this.#cx.services.credentials.isRuntimeActive(identity, signal))) {
                socket.close(1008, "Runtime revoked");
                return false;
            }
        } catch (error) {
            signal.throwIfAborted();
            logger.warn(
                { ...identity, err: error, event: "runtime_authorization_failed", closeCode: 1011 },
                "Runtime authorization unavailable",
            );
            socket.close(1011, "Runtime authorization unavailable");
            return false;
        }
        // A replacement may have been accepted while the authoritative lookup was in flight.
        if (!this.#cx.services.connections.isCurrent(identity)) {
            socket.replaceDaemon();
            return false;
        }
        return socket.isOpen();
    };

    /**
     * A Session's events are delivered in the order the daemon sent them. A batch that carries several
     * Sessions takes its place in each of their lanes, so a later batch for one of them cannot overtake it.
     */
    private readonly daemonMessageLanes = (message: DaemonToRelayMessage): readonly string[] => {
        if (message.kind === SESSION_EVENT_KIND) {
            const sessionIds = new Set(message.events.map((event) => event.sessionId));
            return sessionIds.size === 0 ? ["session:unknown"] : [...sessionIds].map((id) => `session:${id}`);
        }
        return ["runtime"];
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
        for (const { identity, socket, heartbeat } of this.#cx.gateways.peers.daemonConnections()) {
            if (identity.role !== "daemon" || !socket.isOpen()) {
                continue;
            }
            // The host answers heartbeats without running the Relay, so a superseded connection that
            // keeps heartbeating is retired here instead of when it heartbeats.
            if (!this.#cx.services.connections.isCurrent(identity)) {
                socket.replaceDaemon();
                continue;
            }
            const heardAt = heartbeat.kind === "received" ? heartbeat.at : this.firstHeartbeatDue();
            if (heardAt === null || now - heardAt <= DAEMON_HEARTBEAT_SILENCE_LIMIT_MILLISECONDS) {
                continue;
            }
            logger.warn(
                {
                    ...identity,
                    closeCode: 4001,
                    event: "runtime_heartbeat_silence",
                    silenceMilliseconds: now - heardAt,
                },
                "Runtime daemon stopped heartbeating",
            );
            socket.close(4001, "Runtime heartbeat timed out");
            silent.push({ identity, socket });
        }
        return silent;
    };

    /**
     * A daemon sends its first heartbeat once its attachment is ready, which the attachment deadline
     * bounds, so a connection still silent past that deadline counts as silent from it.
     */
    private readonly firstHeartbeatDue = (): number | null => {
        const current = this.#cx.services.connections.current();
        return current === null ? null : current.connectedAt + DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS;
    };

    // The connection may never report its close, so the Relay detaches it itself. The command or
    // read that noticed the silence may end first, so the detach does not share its cancellation.
    private readonly detachDaemons = async (daemons: readonly RuntimePeer[]): Promise<void> => {
        for (const { identity, socket } of daemons) {
            const timeout = new AbortController();
            const timer = setTimeout(
                () => timeout.abort(new DOMException("The Runtime detach timed out", "TimeoutError")),
                DAEMON_DETACH_TIMEOUT_MILLISECONDS,
            );
            try {
                await this.detach(identity, socket, timeout.signal);
            } finally {
                clearTimeout(timer);
            }
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
