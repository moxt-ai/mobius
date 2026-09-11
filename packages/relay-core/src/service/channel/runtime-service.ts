import {
    BOT_BINDING_APPROVED_KIND,
    BOT_BINDING_UNAVAILABLE_KIND,
    decodeBotExecutionBindingApprovedEvent,
    decodeBotExecutionBindingUnavailableEvent,
    decodeMessageKind,
    decodeRuntimeDeliveryReceived,
    decodeRuntimeHeartbeatEvent,
    decodeSessionEventEnvelope,
    encodeRuntimeHeartbeatAckEvent,
    encodeRuntimeLivenessReadyEvent,
    encodeRuntimeStatusEvent,
    RUNTIME_DELIVERY_RECEIVED_KIND,
    RUNTIME_HEARTBEAT_ACK_KIND,
    RUNTIME_HEARTBEAT_KIND,
    RUNTIME_LIVENESS_READY_KIND,
    RUNTIME_STATUS_KIND,
    SESSION_EVENT_KIND,
} from "@moxt-ai/mobius-protocol";
import { ProjectScope } from "../../entity/do/session.ts";
import type { BotRuntimeService } from "../bot/bot-runtime-service.ts";
import type { RemoteSessionRuntime } from "../do/remote-session-runtime.ts";
import type { ChannelActor, ChannelPeers, ChannelSocket } from "./channel-actor.ts";
import type { ChannelCredentialService } from "./channel-credential-service.ts";
import type { RuntimeConnectionService } from "./runtime-connection-service.ts";
import { RuntimeMessageScheduler, RuntimeMessageSchedulerCapacityError } from "./runtime-message-scheduler.ts";
import type { RuntimeRecoveryService } from "./runtime-recovery-service.ts";

export type RuntimeSocketIdentity =
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
        readonly bots: Pick<BotRuntimeService, "approveBinding" | "rejectBinding">;
        readonly recovery: RuntimeRecoveryService;
        readonly channel: (runtimeId: string, scope: ProjectScope) => ChannelActor;
    };
    readonly gateways: {
        readonly peers: RuntimePeers;
        readonly sessions: Pick<RemoteSessionRuntime, "listRuntimeSessionIds" | "disconnectSession">;
        readonly schedule: (timestamp: number, signal: AbortSignal) => Promise<void>;
    };
}

type RuntimeAcceptance =
    | { readonly kind: "conflict" }
    | { readonly kind: "revoked" }
    | { readonly kind: "accepted"; readonly response: Response };

export class RuntimeService {
    readonly #cx: RuntimeContext;
    readonly #channels = new Map<string, ChannelActor>();
    readonly #daemonMessages = new RuntimeMessageScheduler();
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
        await this.resumeDisconnect(signal, false);
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
        for (const { socket } of previous) {
            socket.replaceDaemon();
        }
        if (previous.length > 0 && current !== null) {
            this.#cx.services.connections.saveDisconnect({
                ...current,
                projectId: scope.projectId,
                disconnectedAt: Date.now(),
                progress: { kind: "listing" },
            });
            await this.#cx.gateways.schedule(Date.now() + 30_000, signal);
            await this.resumeDisconnect(signal, false);
        }
        signal.throwIfAborted();
        // No await may separate this durable revocation check from accept + connect.
        const prepared = this.#cx.services.connections.prepare(runtimeId, scope);
        if (prepared.kind !== "ready") {
            return prepared;
        }
        const accepted = this.#cx.gateways.peers.accept({
            ...prepared.identity,
            deliveryReceipts,
            role: "daemon",
            projectId: scope.projectId,
        });
        this.#cx.services.connections.connected(prepared.identity, Date.now());
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
        if (liveness) {
            accepted.socket.send(encodeRuntimeLivenessReadyEvent({ kind: RUNTIME_LIVENESS_READY_KIND }));
        }
        return { kind: "accepted", response: accepted.response };
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
                    progress: { kind: "listing" },
                });
            }
            this.#cx.services.connections.disconnected(current, Date.now());
            await this.#cx.gateways.schedule(Date.now() + 30_000, signal);
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
        await this.#cx.services.recovery.dispatch(runtimeId, scope, signal);
        await this.#cx.services.recovery.reconcile(runtimeId, scope, signal);
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
        await this.#cx.services.recovery.dispatch(runtimeId, scope, signal);
        await this.#cx.services.recovery.reconcile(runtimeId, scope, signal);
    };

    readonly attachHost = (runtimeId: string, scope: ProjectScope, socket: ChannelSocket, signal: AbortSignal) =>
        this.channel(runtimeId, scope).attachHost(socket, signal);

    readonly recover = async (identity: RuntimeSocketIdentity, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
        if (identity.role === "daemon" && this.#cx.services.connections.isCurrent(identity)) {
            await this.#cx.services.recovery.reconcile(
                identity.runtimeId,
                new ProjectScope(identity.projectId),
                signal,
            );
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
        if (identity.role === "host") {
            if (!(await this.#cx.services.credentials.isActive(identity, signal))) {
                socket.close(1008, "Channel access revoked");
                return;
            }
            const channel = this.channel(identity.runtimeId, scope);
            channel.configureDaemonDelivery(this.#currentDaemonDeliveryReceipts());
            await channel.receiveHostMessage(socket, message, signal);
            return;
        }
        // Heartbeats must bypass the durable-write queue.
        if (identity.role === "daemon" && typeof message === "string") {
            try {
                if (decodeMessageKind(message) === RUNTIME_HEARTBEAT_KIND) {
                    if (!this.#cx.services.connections.isCurrent(identity)) {
                        socket.replaceDaemon();
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
        const lane = this.daemonMessageLane(message);
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
                if (typeof message === "string") {
                    const kind = decodeMessageKind(message);
                    if (kind === BOT_BINDING_APPROVED_KIND) {
                        await this.#cx.services.bots.approveBinding(
                            scope,
                            identity.runtimeId,
                            decodeBotExecutionBindingApprovedEvent(message),
                            Date.now(),
                            signal,
                        );
                        socket.send(message);
                        return;
                    }
                    if (kind === BOT_BINDING_UNAVAILABLE_KIND) {
                        await this.#cx.services.bots.rejectBinding(
                            scope,
                            identity.runtimeId,
                            decodeBotExecutionBindingUnavailableEvent(message),
                            Date.now(),
                            signal,
                        );
                        socket.send(message);
                        return;
                    }
                }
                const channel = this.channel(identity.runtimeId, scope);
                channel.configureDaemonDelivery(identity.deliveryReceipts);
                await channel.receiveDaemonMessage(socket, message, signal);
            });
        } catch (error) {
            if (error instanceof RuntimeMessageSchedulerCapacityError) {
                socket.close(1013, error.code);
                return;
            }
            throw error;
        }
    };

    private readonly daemonMessageLane = (message: unknown): string => {
        if (typeof message !== "string") {
            return "runtime";
        }
        try {
            const kind = decodeMessageKind(message);
            if (kind === SESSION_EVENT_KIND) {
                return `session:${decodeSessionEventEnvelope(message).sessionId}`;
            }
            if (kind === RUNTIME_DELIVERY_RECEIVED_KIND) {
                return `session:${decodeRuntimeDeliveryReceived(message).sessionId}`;
            }
        } catch {
            return "runtime";
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
        if (this.#cx.services.connections.pendingDisconnect() === null) {
            this.#cx.services.connections.saveDisconnect({
                ...identity,
                disconnectedAt: Date.now(),
                progress: { kind: "listing" },
            });
        }
        // Arm recovery before waiting for prior frames or any remote session work.
        await this.#cx.gateways.schedule(Date.now() + 30_000, signal);
        await this.resumeDisconnect(signal);
    };

    private readonly resumeDisconnect = async (signal: AbortSignal, announceOffline = true): Promise<void> => {
        const operation = this.#disconnectTail.then(async () => {
            signal.throwIfAborted();
            let job = this.#cx.services.connections.pendingDisconnect();
            if (job === null) {
                return;
            }
            await this.#cx.gateways.schedule(Date.now() + 30_000, signal);
            await this.#daemonMessages.idle(signal);
            signal.throwIfAborted();
            this.#cx.services.connections.disconnected(job, job.disconnectedAt);
            const scope = new ProjectScope(job.projectId);
            let remaining: readonly string[];
            switch (job.progress.kind) {
                case "listing":
                    remaining = await this.#cx.gateways.sessions.listRuntimeSessionIds(scope, job.runtimeId, signal);
                    job = { ...job, progress: { kind: "disconnecting", remaining } };
                    this.#cx.services.connections.saveDisconnect(job);
                    break;
                case "disconnecting":
                    remaining = job.progress.remaining;
                    break;
            }
            for (const [index, sessionId] of remaining.entries()) {
                signal.throwIfAborted();
                await this.#cx.gateways.sessions.disconnectSession(
                    scope,
                    job.runtimeId,
                    sessionId,
                    job.disconnectedAt,
                    signal,
                );
                this.#cx.services.connections.saveDisconnect({
                    ...job,
                    progress: { kind: "disconnecting", remaining: remaining.slice(index + 1) },
                });
            }
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
