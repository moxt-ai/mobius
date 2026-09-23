import {
    type DaemonToServiceMessage,
    decodeDaemonToServiceMessage,
    encodeRuntimeStatusEvent,
    encodeServiceToDaemonMessage,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_STATUS_KIND,
    SESSION_EVENT_KIND,
} from "@moxt-ai/mobius-protocol";
import { ProjectScope } from "../../entity/do/session.ts";
import type { RemoteSessionRuntime } from "../do/remote-session-runtime.ts";
import type { ChannelActor, ChannelPeers, ChannelSocket } from "./channel-actor.ts";
import type { ChannelCredentialService } from "./channel-credential-service.ts";
import type { RuntimeConnectionService } from "./runtime-connection-service.ts";
import { RuntimeMessageScheduler, RuntimeMessageSchedulerCapacityError } from "./runtime-message-scheduler.ts";

const DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS = 30_000;
// Settling a disconnect runs behind `waitUntil`, so it owns its budget. Each Session is checkpointed as it
// settles and the alarm resumes an interrupted settle, so a timeout only defers the remaining work.
const DAEMON_DISCONNECT_SETTLE_TIMEOUT_MILLISECONDS = 30_000;
// A disconnect settles one Session at a time, so the working set is also the settle's step count. Report an
// unusually wide set so an operator can see the Channel accumulating in-flight work before the sweep becomes
// slow: a Channel is meant to carry many Sessions, so this warns rather than refuses.
const DISCONNECT_SETTLE_WARNING_THRESHOLD = 64;

export type RuntimeSocketIdentity =
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
          readonly runtimeId: string;
          readonly projectId: string;
      }
    | {
          readonly role: "daemon" | "replaced-daemon";
          readonly connectionEpoch: number;
          readonly connectionId: string;
          readonly deliveryReceipts: boolean;
          readonly runtimeId: string;
          readonly projectId: string;
      };

export interface RuntimeSocket extends ChannelSocket {
    readonly replaceDaemon: () => void;
}

export interface RuntimePeers extends ChannelPeers {
    readonly sockets: () => readonly { readonly identity: RuntimeSocketIdentity; readonly socket: RuntimeSocket }[];
    readonly accept: (identity: RuntimeSocketIdentity) => {
        readonly socket: RuntimeSocket;
        readonly response: Response;
    };
}

interface RuntimeContext {
    readonly services: {
        readonly connections: RuntimeConnectionService;
        readonly credentials: Pick<ChannelCredentialService, "isActive">;
        readonly channel: (runtimeId: string, scope: ProjectScope) => ChannelActor;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
    };
    readonly runtimes: {
        readonly sessions: Pick<RemoteSessionRuntime, "disconnectSessions">;
    };
    readonly utilities: {
        readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
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
    #disconnectTail: Promise<void> = Promise.resolve();
    #acceptTail: Promise<void> = Promise.resolve();
    readonly #accepting = new Set<{
        readonly runtimeId: string;
        readonly scope: ProjectScope;
        readonly controller: AbortController;
    }>();

    constructor(cx: RuntimeContext) {
        this.#cx = cx;
    }

    readonly acceptDaemon = async (
        runtimeId: string,
        scope: ProjectScope,
        liveness: boolean,
        deliveryReceipts: boolean,
        signal: AbortSignal,
    ) => {
        const accepting = { runtimeId, scope, controller: new AbortController() };
        this.#accepting.add(accepting);
        const operation = this.#acceptTail.then(async (): Promise<RuntimeAcceptance> => {
            try {
                return await this.acceptDaemonSocket(
                    runtimeId,
                    scope,
                    liveness,
                    deliveryReceipts,
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
        deliveryReceipts: boolean,
        signal: AbortSignal,
    ): Promise<RuntimeAcceptance> => {
        signal.throwIfAborted();
        if (this.isRevoked(runtimeId, scope)) {
            return { kind: "revoked" };
        }
        // Settle a pending disconnect off the upgrade path. The daemon's connect deadline is shorter than
        // settling a Runtime that has several Sessions in flight, and timing out here made the daemon
        // reconnect into the same unfinished cleanup. The job is durable and the alarm resumes it, so the
        // accept never has to wait on Session work.
        this.settlePendingDisconnectInBackground();
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
        if (previous.length > 0 && current !== null) {
            this.#cx.services.connections.saveDisconnect({
                ...current,
                projectId: scope.projectId,
                disconnectedAt: Date.now(),
            });
            this.settlePendingDisconnectInBackground();
        }
        signal.throwIfAborted();
        // No await may separate this durable revocation check from accept + connect.
        const prepared = this.#cx.services.connections.prepare(runtimeId, scope);
        if (prepared.kind !== "ready") {
            return prepared;
        }
        const identity: DaemonSocketIdentity = {
            ...prepared.identity,
            deliveryReceipts,
            role: "daemon",
            projectId: scope.projectId,
        };
        const accepted = this.#cx.gateways.peers.accept(identity);
        this.#cx.services.connections.connected(prepared.identity, Date.now());
        if (liveness) {
            this.deferDaemonAttachment(identity, accepted.socket, scope);
            return { kind: "accepted", response: accepted.response };
        }
        try {
            await this.attachDaemon(runtimeId, scope, false, deliveryReceipts, signal);
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
    ): void => {
        const attachment = { controller: new AbortController(), identity };
        this.#attachments.add(attachment);
        const signal = AbortSignal.any([
            attachment.controller.signal,
            AbortSignal.timeout(DAEMON_ATTACHMENT_TIMEOUT_MILLISECONDS),
        ]);
        const operation = (async () => {
            try {
                await this.attachDaemon(identity.runtimeId, scope, false, identity.deliveryReceipts, signal);
                signal.throwIfAborted();
                if (!this.#cx.services.connections.isCurrent(identity)) {
                    return;
                }
                if (this.isRevoked(identity.runtimeId, scope)) {
                    socket.close(1008, "Runtime revoked");
                    return;
                }
                socket.send(encodeServiceToDaemonMessage({ kind: RUNTIME_LIVENESS_READY_KIND }));
            } catch (error) {
                if (!attachment.controller.signal.aborted) {
                    console.error("Runtime attachment failed", error);
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

    /**
     * Settle a Runtime disconnect without delaying the WebSocket upgrade.
     *
     * The upgrade must not wait on Session cleanup, or a Runtime with several Sessions in flight would push the
     * accept past the daemon's connect deadline and leave the daemon reconnecting into unfinished cleanup. The
     * job is durable, and the alarm the settle arms keeps it recoverable when this Durable Object is evicted.
     */
    private readonly settlePendingDisconnectInBackground = (): void => {
        if (this.#cx.services.connections.pendingDisconnect() === null) {
            return;
        }
        // A settle is only ever needed for a stored disconnect job, so an idle connection starts no timers.
        const controller = new AbortController();
        const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(DAEMON_DISCONNECT_SETTLE_TIMEOUT_MILLISECONDS),
        ]);
        const operation = this.resumeDisconnect(signal, false).catch((error: unknown) => {
            if (!controller.signal.aborted) {
                console.error("Mobius relay could not settle a Runtime disconnect", error);
            }
        });
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

    readonly alarm = async (signal: AbortSignal): Promise<void> => {
        await this.resumeDisconnect(signal);
        const daemon = this.#cx.gateways.peers
            .sockets()
            .find(({ identity, socket }) => identity.role === "daemon" && socket.isOpen());
        if (daemon !== undefined) {
            await this.recover(daemon.identity, signal);
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
        const daemons: RuntimeSocket[] = [];
        for (const { identity, socket } of this.#cx.gateways.peers.sockets()) {
            if (identity.runtimeId !== runtimeId || identity.projectId !== scope.projectId) {
                continue;
            }
            if (identity.role === "daemon") {
                daemons.push(socket);
                socket.close(1008, "Runtime revoked");
            } else if (identity.role === "host" && identity.channelId === channelId) {
                socket.close(1008, "Runtime revoked");
            }
        }
        const current = this.#cx.services.connections.current();
        if (current !== null && current.runtimeId === runtimeId) {
            if (daemons.length > 0 && this.#cx.services.connections.pendingDisconnect() === null) {
                this.#cx.services.connections.saveDisconnect({
                    ...current,
                    projectId: scope.projectId,
                    disconnectedAt: Date.now(),
                });
            }
            this.#cx.services.connections.disconnected(current, Date.now());
            await this.#cx.utilities.schedule(Date.now() + 30_000, signal);
        }
        // The durable fence is effective immediately. Session recovery belongs to
        // the armed alarm; revocation must not wait behind in-flight attachment cleanup.
    };

    readonly isOnline = (runtimeId: string): boolean => {
        const current = this.#cx.services.connections.current();
        return (
            current?.state === "online" &&
            current.runtimeId === runtimeId &&
            this.#cx.gateways.peers.daemons().length > 0
        );
    };

    readonly dispatchPending = async (runtimeId: string, scope: ProjectScope, signal: AbortSignal): Promise<void> => {
        const deliveryReceipts = this.#currentDaemonDeliveryReceipts();
        const channel = this.channel(runtimeId, scope);
        channel.configureDaemonDelivery(deliveryReceipts);
        await channel.dispatchPending(signal);
    };

    readonly attachDaemon = async (
        runtimeId: string,
        scope: ProjectScope,
        replaced: boolean,
        deliveryReceipts: boolean,
        signal: AbortSignal,
    ): Promise<void> => {
        const channel = this.channel(runtimeId, scope);
        channel.configureDaemonDelivery(deliveryReceipts);
        await channel.attachDaemon(replaced, signal);
    };

    readonly attachHost = (runtimeId: string, scope: ProjectScope, socket: ChannelSocket, signal: AbortSignal) =>
        this.channel(runtimeId, scope).attachHost(socket, signal);

    readonly recover = async (_identity: RuntimeSocketIdentity, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
    };

    readonly receiveMessage = async (
        identity: RuntimeSocketIdentity,
        socket: RuntimeSocket,
        message: unknown,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const scope = new ProjectScope(identity.projectId);
        if (identity.role === "host" || identity.role === "relay") {
            if (identity.role === "relay") {
                const channel = this.channel(identity.runtimeId, scope);
                channel.configureDaemonDelivery(this.#currentDaemonDeliveryReceipts());
                await channel.receiveHostMessage(scope, socket, message, signal);
                return;
            }
            if (!(await this.#cx.services.credentials.isActive(identity, signal))) {
                socket.close(1008, "Channel access revoked");
                return;
            }
            const channel = this.channel(identity.runtimeId, scope);
            channel.configureDaemonDelivery(this.#currentDaemonDeliveryReceipts());
            await channel.receiveHostMessage(scope, socket, message, signal);
            return;
        }
        if (typeof message !== "string" || message.length > 8 * 1024 * 1024) {
            socket.close(1003, "Bounded text message required");
            return;
        }
        let daemonMessage: DaemonToServiceMessage;
        try {
            daemonMessage = decodeDaemonToServiceMessage(message);
        } catch {
            socket.close(1008, "Invalid protocol message");
            return;
        }
        // Heartbeats must bypass the durable-write queue.
        if (identity.role === "daemon" && daemonMessage.kind === RUNTIME_HEARTBEAT_KIND) {
            if (!this.#cx.services.connections.isCurrent(identity)) {
                socket.replaceDaemon();
                return;
            }
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
                channel.configureDaemonDelivery(identity.deliveryReceipts);
                await channel.receiveDaemonMessage(socket, daemonMessage, signal);
            });
        } catch (error) {
            if (error instanceof RuntimeMessageSchedulerCapacityError) {
                socket.close(1013, error.code);
                return;
            }
            throw error;
        }
    };

    private readonly daemonMessageLane = (message: DaemonToServiceMessage): string => {
        if (message.kind === SESSION_EVENT_KIND || message.kind === RUNTIME_DELIVERY_RECEIVED_KIND) {
            return `session:${message.sessionId}`;
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

    readonly #currentDaemonDeliveryReceipts = (): boolean =>
        this.#cx.gateways.peers
            .sockets()
            .some(({ identity, socket }) =>
                identity.role === "daemon" && socket.isOpen() ? identity.deliveryReceipts : false,
            );

    readonly detach = async (
        identity: RuntimeSocketIdentity,
        _socket: ChannelSocket,
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
        if (this.#cx.services.connections.pendingDisconnect() === null) {
            this.#cx.services.connections.saveDisconnect({
                ...identity,
                disconnectedAt: Date.now(),
            });
        }
        // Arm recovery before waiting for prior frames or any remote session work.
        await this.#cx.utilities.schedule(Date.now() + 30_000, signal);
        await this.resumeDisconnect(signal);
    };

    private readonly resumeDisconnect = async (signal: AbortSignal, announceOffline = true): Promise<void> => {
        const operation = this.#disconnectTail.then(async () => {
            signal.throwIfAborted();
            const pending = this.#cx.services.connections.pendingDisconnect();
            if (pending === null) {
                return;
            }
            const job = pending;
            await this.#cx.utilities.schedule(Date.now() + 30_000, signal);
            await this.#daemonMessages.idle(signal);
            signal.throwIfAborted();
            this.#cx.services.connections.disconnected(job, job.disconnectedAt);
            const scope = new ProjectScope(job.projectId);
            // Only the Sessions this Runtime still had work for can hold an in-flight Attempt. Settling that
            // recorded set keeps the sweep proportional to the Runtime's outstanding work rather than to every
            // Session the Project ever created, so a Session whose Turn already finished is never revisited.
            // The recorded set is also the checkpoint: each Session is forgotten as it settles, so an
            // interrupted sweep resumes exactly the Sessions still outstanding instead of replaying settled
            // ones, which would regress an Attempt the daemon has since reconciled.
            const remaining = this.#cx.services.connections
                .listActiveSessions(job.runtimeId)
                .filter((session) => session.connectionEpoch === job.connectionEpoch);
            if (remaining.length > DISCONNECT_SETTLE_WARNING_THRESHOLD) {
                console.warn(
                    `Mobius relay is settling ${remaining.length.toString()} in-flight Sessions for Runtime ${job.runtimeId}; a Channel may carry any number of Sessions, so this is reported as a slow-disconnect signal.`,
                );
            }
            await this.#cx.runtimes.sessions.disconnectSessions(
                scope,
                job.runtimeId,
                remaining,
                job.disconnectedAt,
                signal,
                (session) =>
                    this.#cx.services.connections.clearActiveSession(
                        job.runtimeId,
                        session.sessionId,
                        session.connectionEpoch,
                    ),
            );
            this.#cx.services.connections.completeDisconnect();
            if (announceOffline) {
                for (const host of this.#cx.gateways.peers.hosts()) {
                    if (host.isOpen()) {
                        host.send(
                            encodeRuntimeStatusEvent({
                                kind: RUNTIME_STATUS_KIND,
                                runtimeId: job.runtimeId,
                                online: false,
                            }),
                        );
                    }
                }
            }
        });
        this.#disconnectTail = operation.catch(() => undefined);
        await operation;
    };
}
