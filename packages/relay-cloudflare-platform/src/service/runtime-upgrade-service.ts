import { decodeIdentifier, encodeServiceToDaemonMessage, type RuntimeUpgradeResult } from "@moxt-ai/mobius-protocol";
import type { RuntimeManagement, RuntimePeers } from "@moxt-ai/mobius-relay-core";
import { needsUpgrade, rolloutMatches } from "../entity/runtime-rollout.ts";
import { sanitizedUpgradeError, type UpgradeErrorReporting } from "../gateway/upgrade-error-reporting.ts";
import type { AppUpgradeStorage } from "../storage/app-upgrade-storage.ts";
import type { RuntimeUpgradeStorage } from "../storage/runtime-upgrade-storage.ts";

export class RuntimeUpgradeService implements RuntimeManagement {
    #checking: Promise<void> | null = null;
    #lastCheck = 0;
    private readonly peers: RuntimePeers;
    private readonly storage: RuntimeUpgradeStorage;
    private readonly tasks: AppUpgradeStorage;
    private readonly reporter: UpgradeErrorReporting;
    private readonly waitUntil: (promise: Promise<void>) => void;
    constructor(
        peers: RuntimePeers,
        storage: RuntimeUpgradeStorage,
        tasks: AppUpgradeStorage,
        reporter: UpgradeErrorReporting,
        waitUntil: (promise: Promise<void>) => void,
    ) {
        this.peers = peers;
        this.storage = storage;
        this.tasks = tasks;
        this.reporter = reporter;
        this.waitUntil = waitUntil;
    }
    readonly connected: RuntimeManagement["connected"] = async (runtimeId, projectId, signal) => {
        this.storage.touch(runtimeId, projectId, Date.now());
        this.#lastCheck = 0;
        this.requestVersion();
        signal.throwIfAborted();
    };
    private readonly requestVersion = (): void => {
        const requestId = decodeIdentifier(`updiag_${crypto.randomUUID()}`);
        this.send({ kind: "runtime.diagnostics.read", requestId });
    };
    readonly message: RuntimeManagement["message"] = async (runtimeId, projectId, message, signal) => {
        if (
            message.kind !== "runtime.diagnostics.result" &&
            message.kind !== "runtime.upgrade.result" &&
            message.kind !== "runtime.heartbeat"
        ) {
            return false;
        }
        this.storage.touch(runtimeId, projectId, Date.now());
        if (message.kind === "runtime.diagnostics.result" && message.requestId.startsWith("updiag_")) {
            this.storage.version(message.version);
            await this.check(runtimeId, projectId, signal, true);
            return true;
        } else if (message.kind === "runtime.upgrade.result") {
            const previous = this.snapshot(runtimeId, projectId);
            if (previous.attempt !== null && previous.attempt.requestId !== message.requestId) {
                return true;
            }
            if (
                previous.latest?.result.requestId === message.requestId &&
                previous.latest.result.outcome.status !== "accepted"
            ) {
                return true;
            }
            const outcome = message.outcome;
            const clean: RuntimeUpgradeResult =
                outcome.status === "failed"
                    ? {
                          ...message,
                          outcome: {
                              ...outcome,
                              message: sanitizedUpgradeError(outcome.message).slice(0, 256),
                              ...(outcome.stdout === undefined
                                  ? {}
                                  : { stdout: sanitizedUpgradeError(outcome.stdout) }),
                              ...(outcome.stderr === undefined
                                  ? {}
                                  : { stderr: sanitizedUpgradeError(outcome.stderr) }),
                          },
                      }
                    : message;
            if (this.storage.result(clean, Date.now())) {
                const appId = await this.tasks.projectApp(projectId, signal);
                if (appId !== null) {
                    this.waitUntil(
                        this.reporter
                            .report(appId, runtimeId, projectId, clean, AbortSignal.timeout(5000))
                            .catch(() => {
                                console.warn("Upgrade error reporting unavailable");
                            }),
                    );
                }
            }
            return true;
        } else if (message.kind === "runtime.heartbeat") {
            await this.check(runtimeId, projectId, signal, false);
        }
        return false;
    };
    readonly snapshot = (runtimeId: string, projectId: string) =>
        this.storage.read(runtimeId, projectId, this.online(runtimeId, projectId));
    readonly check = (runtimeId: string, projectId: string, signal: AbortSignal, force: boolean): Promise<void> => {
        if (this.#checking !== null) {
            return this.#checking;
        }
        if (!force && Date.now() - this.#lastCheck < 60_000) {
            return Promise.resolve();
        }
        this.#lastCheck = Date.now();
        this.#checking = this.reconcile(runtimeId, projectId, signal).finally(() => {
            this.#checking = null;
        });
        return this.#checking;
    };
    private readonly reconcile = async (runtimeId: string, projectId: string, signal: AbortSignal): Promise<void> => {
        if (!this.online(runtimeId, projectId)) {
            return;
        }
        const state = this.snapshot(runtimeId, projectId);
        if (state.version === null) {
            this.requestVersion();
            return;
        }
        const appId = await this.tasks.projectApp(projectId, signal);
        if (appId === null) {
            return;
        }
        const task = await this.tasks.read(appId, signal);
        if (task === null || !(await rolloutMatches(runtimeId, task.percentage))) {
            return;
        }
        if (!needsUpgrade(state.version, task.version)) {
            return;
        }
        const outcome = state.latest?.result.outcome;
        if ((outcome?.status === "failed" || outcome?.status === "rejected") && outcome.retryAfter > Date.now()) {
            return;
        }
        if (state.attempt?.revision === task.revision && state.latest?.result.requestId !== state.attempt.requestId) {
            return;
        }
        if (state.attempt?.revision === task.revision && outcome?.status === "accepted") {
            return;
        }
        if (state.attempt !== null && Date.now() - state.attempt.sentAt < 60_000) {
            return;
        }
        const latest = await this.tasks.read(appId, signal);
        signal.throwIfAborted();
        if (latest?.revision !== task.revision || !this.online(runtimeId, projectId)) {
            return;
        }
        const requestId = decodeIdentifier(`upg_${crypto.randomUUID()}`);
        this.storage.attempt({ requestId, revision: task.revision, version: task.version, sentAt: Date.now() });
        this.send({ kind: "runtime.upgrade.request", requestId, version: task.version });
    };
    private readonly online = (runtimeId: string, projectId: string): boolean =>
        this.peers
            .sockets()
            .some(
                ({ identity, socket }) =>
                    identity.role === "daemon" &&
                    identity.runtimeId === runtimeId &&
                    identity.projectId === projectId &&
                    socket.isOpen(),
            );
    private readonly send = (message: Parameters<typeof encodeServiceToDaemonMessage>[0]): void => {
        const socket = this.peers.daemons().find((socket) => socket.isOpen());
        socket?.send(encodeServiceToDaemonMessage(message));
    };
}
