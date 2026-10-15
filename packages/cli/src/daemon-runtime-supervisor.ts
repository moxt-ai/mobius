import { errorMessage, type ManagedRuntimeStatus, type ManagedRuntimeSummary } from "./daemon-manager-protocol.ts";
import { type ActiveRuntime, startWorkerProcess, waitForReady } from "./daemon-worker-process.ts";
import { pairLocalMachine, resumeLocalMachine } from "./pairing/pair-local-machine.ts";
import type { RuntimeInstallationStore, VerifiedRuntimeConnection } from "./storage/runtime-installation-store.ts";

function summary(connection: VerifiedRuntimeConnection, status: ManagedRuntimeStatus): ManagedRuntimeSummary {
    return {
        appId: connection.appId,
        connectionId: connection.connectionId,
        runtimeId: connection.runtimeId,
        status,
        workspace: connection.defaultWorkspace,
    };
}

export class RuntimeSupervisor {
    readonly #failed = new Map<string, VerifiedRuntimeConnection>();
    readonly #installation: RuntimeInstallationStore;
    readonly #signal: AbortSignal;
    readonly #pairingRequests = new Map<
        string,
        Promise<{ readonly alreadyOnline: boolean; readonly pair: ManagedRuntimeSummary }>
    >();
    readonly #restoring = new Map<string, VerifiedRuntimeConnection>();
    readonly #runtimes = new Map<string, ActiveRuntime>();
    readonly #stopped = new Map<string, VerifiedRuntimeConnection>();

    constructor(installation: RuntimeInstallationStore, signal: AbortSignal) {
        this.#installation = installation;
        this.#signal = signal;
    }

    readonly restore = async (signal: AbortSignal): Promise<void> => {
        const connections = await this.#installation.listConnections(signal);
        for (const connection of connections) {
            if (connection.activation === "stopped") {
                this.#stopped.set(connection.connectionId, connection);
            } else {
                this.#restoring.set(connection.connectionId, connection);
            }
        }
        await Promise.all(
            connections.filter((connection) => connection.activation === "active").map(this.#restoreConnection),
        );
    };

    readonly #restoreConnection = async (connection: VerifiedRuntimeConnection): Promise<void> => {
        try {
            const active = this.#activate(connection);
            await active.started;
        } catch (cause) {
            this.#restoring.delete(connection.connectionId);
            this.#failed.set(connection.connectionId, connection);
            process.stderr.write(`Could not restore ${connection.connectionId}: ${errorMessage(cause)}\n`);
        }
    };

    readonly pair = async (
        arguments_: readonly string[],
        signal: AbortSignal,
    ): Promise<{ readonly alreadyOnline: boolean; readonly pair: ManagedRuntimeSummary }> => {
        const pairingId = pairingIdentifier(arguments_);
        if (pairingId === null) {
            return await this.#pair(arguments_, signal);
        }
        const pending = this.#pairingRequests.get(pairingId);
        if (pending !== undefined) {
            return await pending;
        }
        const request = this.#pair(arguments_, signal);
        this.#pairingRequests.set(pairingId, request);
        try {
            return await request;
        } finally {
            if (this.#pairingRequests.get(pairingId) === request) {
                this.#pairingRequests.delete(pairingId);
            }
        }
    };

    readonly #pair = async (
        arguments_: readonly string[],
        signal: AbortSignal,
    ): Promise<{ readonly alreadyOnline: boolean; readonly pair: ManagedRuntimeSummary }> => {
        const paired = await pairLocalMachine(arguments_, signal);
        const connection = await this.#installation.setConnectionActivation(paired.connectionId, "active", signal);
        const alreadyOnline = this.#runtimes.get(connection.connectionId)?.status === "online";
        const active = this.#activate(connection);
        await waitForReady(active, signal);
        return { alreadyOnline, pair: summary(connection, active.status) };
    };

    readonly start = async (arguments_: readonly string[], signal: AbortSignal): Promise<ManagedRuntimeSummary> => {
        const paired = await resumeLocalMachine(arguments_, signal);
        const connection = await this.#installation.setConnectionActivation(paired.connectionId, "active", signal);
        const active = this.#activate(connection);
        await waitForReady(active, signal);
        return summary(connection, active.status);
    };

    readonly stop = async (connectionId: string, signal: AbortSignal): Promise<ManagedRuntimeSummary> => {
        let connection = await this.#installation.readConnection(connectionId, signal);
        const active = this.#runtimes.get(connection.connectionId);
        if (active !== undefined) {
            active.controller.abort();
            await active.completion;
            this.#runtimes.delete(connection.connectionId);
        }
        connection = await this.#installation.setConnectionActivation(connection.connectionId, "stopped", signal);
        this.#failed.delete(connection.connectionId);
        this.#stopped.set(connection.connectionId, connection);
        return summary(connection, "stopped");
    };

    readonly remove = async (connectionId: string, signal: AbortSignal): Promise<string> => {
        const stopped = await this.stop(connectionId, signal);
        await this.#installation.removeConnection(stopped.connectionId, signal);
        this.#stopped.delete(stopped.connectionId);
        return stopped.connectionId;
    };

    readonly list = (): readonly ManagedRuntimeSummary[] =>
        [
            ...[...this.#runtimes.values()].map((active) => summary(active.connection, active.status)),
            ...[...this.#restoring.values()].map((connection) => summary(connection, "starting")),
            ...[...this.#failed.values()].map((connection) => summary(connection, "failed")),
            ...[...this.#stopped.values()].map((connection) => summary(connection, "stopped")),
        ].sort(
            (left, right) =>
                left.appId.localeCompare(right.appId) || left.connectionId.localeCompare(right.connectionId),
        );

    readonly close = async (): Promise<void> => {
        const runtimes = [...this.#runtimes.values()];
        for (const runtime of runtimes) {
            runtime.controller.abort();
        }
        await Promise.all(runtimes.map(async (runtime) => await runtime.completion));
    };

    #activate(connection: VerifiedRuntimeConnection): ActiveRuntime {
        this.#signal.throwIfAborted();
        const existing = this.#runtimes.get(connection.connectionId);
        if (existing !== undefined) {
            return existing;
        }
        const active = startWorkerProcess(connection, this.#signal, this.#workerExited);
        this.#runtimes.set(connection.connectionId, active);
        this.#restoring.delete(connection.connectionId);
        this.#failed.delete(connection.connectionId);
        this.#stopped.delete(connection.connectionId);
        return active;
    }

    readonly #workerExited = (active: ActiveRuntime): void => {
        const connection = active.connection;
        this.#runtimes.delete(connection.connectionId);
        if (active.status === "failed") {
            this.#failed.set(connection.connectionId, connection);
        }
    };
}

function pairingIdentifier(arguments_: readonly string[]): string | null {
    const indexes = arguments_.flatMap((argument, index) => (argument === "--pairing" ? [index] : []));
    if (indexes.length !== 1) {
        return null;
    }
    const index = indexes[0];
    return index === undefined ? null : (arguments_[index + 1] ?? null);
}
