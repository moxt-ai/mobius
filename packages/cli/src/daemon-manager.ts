import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonWorkerError, decodeWorkerEvent } from "./daemon-worker-protocol.ts";
import { pairLocalMachine, resumeLocalMachine } from "./pairing/pair-local-machine.ts";
import { platformSupportFor } from "./platform/index.ts";
import type { RuntimeInstallationStore, VerifiedRuntimeConnection } from "./storage/runtime-installation-store.ts";

const CONTROL_TIMEOUT_MILLISECONDS = 130_000;
const START_TIMEOUT_MILLISECONDS = 120_000;
const MAXIMUM_MESSAGE_BYTES = 64 * 1024;
const CONNECTION_ID_PATTERN = /^mcn_[a-f0-9]{32}$/;

export type ManagedRuntimeStatus = "starting" | "online" | "reconnecting" | "failed" | "stopped";

export interface ManagedRuntimeSummary {
    readonly appId: string;
    readonly connectionId: string;
    readonly runtimeId: string;
    readonly status: ManagedRuntimeStatus;
    readonly workspace: string;
}

type ManagerCommand =
    | { readonly kind: "list" }
    | { readonly arguments: readonly string[]; readonly kind: "pair" }
    | { readonly connectionId: string; readonly kind: "remove-pair" }
    | { readonly arguments: readonly string[]; readonly kind: "start" }
    | { readonly connectionId: string; readonly kind: "stop-pair" }
    | { readonly kind: "stop" };

export type ManagerResponse =
    | { readonly kind: "error"; readonly code: string; readonly message: string }
    | {
          readonly kind: "listed";
          readonly managerVersion: string;
          readonly pairs: readonly ManagedRuntimeSummary[];
      }
    | { readonly connectionId: string; readonly kind: "pair-removed" }
    | { readonly kind: "pair-stopped"; readonly pair: ManagedRuntimeSummary }
    | { readonly alreadyOnline: boolean; readonly kind: "ready"; readonly pair: ManagedRuntimeSummary }
    | { readonly kind: "stopped" };

interface ActiveRuntime {
    readonly connection: VerifiedRuntimeConnection;
    readonly controller: AbortController;
    readonly completion: Promise<void>;
    readonly started: Promise<void>;
    readonly ready: Promise<void>;
    readonly resolveReady: () => void;
    status: ManagedRuntimeStatus;
}

async function acquireManagerLock(stateDirectory: string): Promise<(() => Promise<void>) | null> {
    const path = join(stateDirectory, "manager.lock");
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await writeFile(path, `${process.pid.toString()}\n`, { flag: "wx", mode: 0o600 });
            return async () => await unlink(path).catch(() => undefined);
        } catch (cause) {
            if (!isNodeError(cause, "EEXIST")) {
                throw cause;
            }
            const encoded = await readFile(path, "utf8").catch(() => "");
            const pid = Number(encoded.trim());
            if (Number.isSafeInteger(pid) && pid > 1) {
                try {
                    process.kill(pid, 0);
                    return null;
                } catch (probeCause) {
                    if (!isNodeError(probeCause, "ESRCH")) {
                        return null;
                    }
                }
            }
            await unlink(path).catch(() => undefined);
        }
    }
    return null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const managerPlatform = platformSupportFor(process.platform);

function controlSocketPath(stateDirectory: string): string {
    const installationHash = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 32);
    return managerPlatform.controlSocketPath(installationHash);
}

function controlTokenPath(stateDirectory: string): string {
    return join(stateDirectory, "manager.token");
}

async function readOrCreateControlToken(stateDirectory: string): Promise<string> {
    const path = controlTokenPath(stateDirectory);
    try {
        return (await readFile(path, "utf8")).trim();
    } catch (cause) {
        if (!isNodeError(cause, "ENOENT")) {
            throw cause;
        }
    }
    const token = randomBytes(32).toString("base64url");
    try {
        await writeFile(path, `${token}\n`, { flag: "wx", mode: 0o600 });
        return token;
    } catch (cause) {
        if (!isNodeError(cause, "EEXIST")) {
            throw cause;
        }
        return (await readFile(path, "utf8")).trim();
    }
}

function isNodeError(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function decodeCommand(value: unknown, expectedToken: string): ManagerCommand {
    if (!isRecord(value) || value["token"] !== expectedToken || typeof value["kind"] !== "string") {
        throw new Error("The manager request is invalid");
    }
    if (value["kind"] === "list" || value["kind"] === "stop") {
        return { kind: value["kind"] };
    }
    if (
        (value["kind"] === "remove-pair" || value["kind"] === "stop-pair") &&
        typeof value["connectionId"] === "string" &&
        CONNECTION_ID_PATTERN.test(value["connectionId"])
    ) {
        return { connectionId: value["connectionId"], kind: value["kind"] };
    }
    if (value["kind"] === "pair" || value["kind"] === "start") {
        const arguments_ = value["arguments"];
        if (
            !Array.isArray(arguments_) ||
            arguments_.length > 16 ||
            !arguments_.every((argument) => typeof argument === "string" && argument.length <= 4096)
        ) {
            throw new Error("The manager command arguments are invalid");
        }
        return { arguments: arguments_, kind: value["kind"] };
    }
    throw new Error("The manager command is unsupported");
}

function decodeResponse(value: unknown): ManagerResponse {
    if (!isRecord(value) || typeof value["kind"] !== "string") {
        throw new Error("The Mobius manager returned an invalid response");
    }
    if (value["kind"] === "error" && typeof value["code"] === "string" && typeof value["message"] === "string") {
        return { code: value["code"], kind: "error", message: value["message"] };
    }
    if (value["kind"] === "stopped") {
        return { kind: "stopped" };
    }
    if (value["kind"] === "pair-stopped" && isManagedRuntimeSummary(value["pair"])) {
        return { kind: "pair-stopped", pair: value["pair"] };
    }
    if (value["kind"] === "pair-removed" && typeof value["connectionId"] === "string") {
        return { connectionId: value["connectionId"], kind: "pair-removed" };
    }
    if (
        value["kind"] === "ready" &&
        typeof value["alreadyOnline"] === "boolean" &&
        isManagedRuntimeSummary(value["pair"])
    ) {
        return { alreadyOnline: value["alreadyOnline"], kind: "ready", pair: value["pair"] };
    }
    if (value["kind"] === "listed" && Array.isArray(value["pairs"]) && value["pairs"].every(isManagedRuntimeSummary)) {
        const managerVersion = value["managerVersion"];
        if (typeof managerVersion === "string" && managerVersion.length > 0 && managerVersion.length <= 128) {
            return { kind: "listed", managerVersion, pairs: value["pairs"] };
        }
    }
    throw new Error("The Mobius manager returned an invalid response");
}

function isManagedRuntimeSummary(value: unknown): value is ManagedRuntimeSummary {
    return (
        isRecord(value) &&
        typeof value["appId"] === "string" &&
        typeof value["connectionId"] === "string" &&
        typeof value["runtimeId"] === "string" &&
        typeof value["workspace"] === "string" &&
        ["starting", "online", "reconnecting", "failed", "stopped"].includes(String(value["status"]))
    );
}

function summary(connection: VerifiedRuntimeConnection, status: ManagedRuntimeStatus): ManagedRuntimeSummary {
    return {
        appId: connection.appId,
        connectionId: connection.connectionId,
        runtimeId: connection.runtimeId,
        status,
        workspace: connection.defaultWorkspace,
    };
}

class RuntimeSupervisor {
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
            connections
                .filter((connection) => connection.activation === "active")
                .map(async (connection) => {
                    try {
                        const active = this.#activate(connection);
                        await active.started;
                    } catch (cause) {
                        this.#restoring.delete(connection.connectionId);
                        this.#failed.set(connection.connectionId, connection);
                        process.stderr.write(`Could not restore ${connection.connectionId}: ${errorMessage(cause)}\n`);
                    }
                }),
        );
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
        const controller = new AbortController();
        const stopForManager = (): void => controller.abort();
        this.#signal.addEventListener("abort", stopForManager, { once: true });
        const readiness = Promise.withResolvers<void>();
        void readiness.promise.catch(() => undefined);
        const started = Promise.withResolvers<void>();
        const completion = Promise.withResolvers<void>();
        const active: ActiveRuntime = {
            connection,
            controller,
            completion: completion.promise,
            started: started.promise,
            ready: readiness.promise,
            resolveReady: readiness.resolve,
            status: "starting",
        };
        this.#runtimes.set(connection.connectionId, active);
        this.#restoring.delete(connection.connectionId);
        this.#failed.delete(connection.connectionId);
        this.#stopped.delete(connection.connectionId);
        const cli = fileURLToPath(new URL(`./cli${extname(import.meta.url)}`, import.meta.url));
        const child = spawn(process.execPath, [cli, "__worker", "--connection", connection.connectionId], {
            env: process.env,
            windowsHide: true,
            stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        let failure: Error | undefined;
        const stop = (): void => {
            if (child.connected) {
                child.send({ kind: "stop" }, (error) => {
                    if (error !== null && child.connected) {
                        child.disconnect();
                    }
                });
            }
        };
        controller.signal.addEventListener("abort", stop, { once: true });
        const startupTimeout = setTimeout(() => {
            failure = new DaemonWorkerError("worker_start_timeout", "Daemon worker startup timed out");
            stop();
        }, START_TIMEOUT_MILLISECONDS);
        child.on("message", (value: unknown) => {
            try {
                const event = decodeWorkerEvent(value);
                if (event.kind === "failed") {
                    failure = new DaemonWorkerError(event.code, event.message);
                    return;
                }
                clearTimeout(startupTimeout);
                active.status = event.status;
                started.resolve();
                if (event.status === "online") {
                    active.resolveReady();
                }
            } catch (cause) {
                failure =
                    cause instanceof Error
                        ? cause
                        : new DaemonWorkerError("worker_protocol_invalid", "Invalid daemon worker event");
                stop();
            }
        });
        child.once("error", (cause) => {
            failure = cause;
        });
        child.once("close", (code, exitSignal) => {
            clearTimeout(startupTimeout);
            this.#signal.removeEventListener("abort", stopForManager);
            controller.signal.removeEventListener("abort", stop);
            this.#runtimes.delete(connection.connectionId);
            if (!controller.signal.aborted) {
                active.status = "failed";
                this.#failed.set(connection.connectionId, connection);
                process.stderr.write(
                    `Runtime ${connection.connectionId} failed: ${failure?.message ?? `Worker exited (${code ?? exitSignal})`}\n`,
                );
            } else {
                active.status = "stopped";
            }
            started.resolve();
            readiness.reject(
                failure ??
                    new DaemonWorkerError(
                        controller.signal.aborted ? "worker_stopped" : "worker_exited",
                        controller.signal.aborted
                            ? "The daemon worker stopped"
                            : "The daemon worker exited before connecting",
                    ),
            );
            completion.resolve();
        });
        return active;
    }
}

function pairingIdentifier(arguments_: readonly string[]): string | null {
    const indexes = arguments_.flatMap((argument, index) => (argument === "--pairing" ? [index] : []));
    if (indexes.length !== 1) {
        return null;
    }
    const index = indexes[0];
    return index === undefined ? null : (arguments_[index + 1] ?? null);
}

async function waitForReady(active: ActiveRuntime, signal: AbortSignal): Promise<void> {
    if (active.status === "online") {
        return;
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(START_TIMEOUT_MILLISECONDS)]);
    await new Promise<void>((resolve, reject) => {
        const abort = (): void => reject(deadline.reason);
        active.ready.then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort));
        deadline.addEventListener("abort", abort, { once: true });
    });
    if (active.status === "failed" || active.status === "stopped") {
        throw new DaemonWorkerError("worker_not_online", "The Runtime stopped or failed before connecting");
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown failure";
}

async function readSocketMessage(socket: Socket, signal: AbortSignal): Promise<unknown> {
    return await new Promise((resolve, reject) => {
        let encoded = "";
        const finish = (error?: unknown, value?: unknown): void => {
            signal.removeEventListener("abort", abort);
            socket.removeAllListeners("data");
            socket.removeAllListeners("error");
            socket.removeAllListeners("end");
            if (error === undefined) {
                resolve(value);
            } else {
                reject(error);
            }
        };
        const abort = (): void => {
            socket.destroy();
            finish(signal.reason);
        };
        socket.on("data", (chunk: Buffer) => {
            encoded += chunk.toString("utf8");
            if (encoded.length > MAXIMUM_MESSAGE_BYTES) {
                finish(new Error("The manager message is too large"));
                socket.destroy();
                return;
            }
            const newline = encoded.indexOf("\n");
            if (newline >= 0) {
                try {
                    finish(undefined, JSON.parse(encoded.slice(0, newline)));
                } catch (cause) {
                    finish(cause);
                }
            }
        });
        socket.once("error", finish);
        socket.once("end", () => finish(new Error("The manager connection closed without a response")));
        signal.addEventListener("abort", abort, { once: true });
    });
}

async function sendControlRequest(
    stateDirectory: string,
    command: ManagerCommand,
    signal: AbortSignal,
): Promise<ManagerResponse> {
    const token = await readOrCreateControlToken(stateDirectory);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    const socket = createConnection(controlSocketPath(stateDirectory));
    try {
        await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                socket.destroy();
                reject(deadline.reason);
            };
            socket.once("connect", () => {
                deadline.removeEventListener("abort", abort);
                resolve();
            });
            socket.once("error", reject);
            deadline.addEventListener("abort", abort, { once: true });
        });
        socket.write(`${JSON.stringify({ ...command, token })}\n`);
        return decodeResponse(await readSocketMessage(socket, deadline));
    } finally {
        socket.destroy();
    }
}

async function spawnManager(): Promise<ChildProcess> {
    const child = spawn(process.execPath, [process.argv[1] ?? "", "__manager"], {
        detached: true,
        windowsHide: true,
        env: process.env,
        stdio: "ignore",
    });
    child.unref();
    return child;
}

async function launchManager(managerVersion: string): Promise<void> {
    process.stdout.write(`Starting mobius daemon ${managerVersion}\n`);
    await spawnManager();
}

async function waitForManagerExit(stateDirectory: string, signal: AbortSignal): Promise<void> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    while (!deadline.aborted) {
        try {
            await readFile(join(stateDirectory, "manager.lock"), "utf8");
        } catch (cause) {
            if (isNodeError(cause, "ENOENT")) {
                return;
            }
            throw cause;
        }
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(finish, 20);
            const abort = (): void => finish(deadline.reason);
            function finish(cause?: unknown): void {
                clearTimeout(timeout);
                deadline.removeEventListener("abort", abort);
                cause === undefined ? resolve() : reject(cause);
            }
            deadline.addEventListener("abort", abort, { once: true });
        });
    }
    throw deadline.reason;
}

export async function requestManager(
    installation: RuntimeInstallationStore,
    managerVersion: string,
    command: ManagerCommand,
    signal: AbortSignal,
): Promise<ManagerResponse> {
    if (managerVersion.length === 0 || managerVersion.length > 128) {
        throw new Error("The Mobius manager version is invalid");
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONTROL_TIMEOUT_MILLISECONDS)]);
    if (command.kind === "stop") {
        return await stopManager(installation.stateDirectory, deadline);
    }
    const listed = await ensureMatchingManager(installation.stateDirectory, managerVersion, deadline);
    if (command.kind === "list") {
        return listed;
    }
    return await sendControlRequest(installation.stateDirectory, command, deadline);
}

async function ensureMatchingManager(
    stateDirectory: string,
    managerVersion: string,
    signal: AbortSignal,
): Promise<Extract<ManagerResponse, { readonly kind: "listed" }>> {
    let managerStarted = false;
    while (!signal.aborted) {
        try {
            const response = await sendControlRequest(stateDirectory, { kind: "list" }, signal);
            if (response.kind === "listed" && response.managerVersion === managerVersion) {
                if (managerStarted) {
                    process.stdout.write(`Mobius daemon ${managerVersion} started\n`);
                }
                return response;
            }
            if (response.kind !== "listed") {
                if (response.kind === "error") {
                    throw new Error(response.message);
                }
                throw new Error("The Mobius manager returned an unexpected response");
            }
            await stopManager(stateDirectory, signal);
            await launchManager(managerVersion);
            managerStarted = true;
        } catch (cause) {
            if (!isNodeError(cause, "ENOENT") && !isNodeError(cause, "ECONNREFUSED")) {
                throw cause;
            }
            if (!managerStarted) {
                await launchManager(managerVersion);
                managerStarted = true;
            }
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(finish, 50);
                const abort = (): void => finish(signal.reason);
                function finish(cause?: unknown): void {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", abort);
                    cause === undefined ? resolve() : reject(cause);
                }
                signal.addEventListener("abort", abort, { once: true });
            });
        }
    }
    throw signal.reason;
}

async function stopManager(
    stateDirectory: string,
    signal: AbortSignal,
): Promise<Extract<ManagerResponse, { kind: "stopped" }>> {
    try {
        const response = await sendControlRequest(stateDirectory, { kind: "stop" }, signal);
        if (response.kind === "error") {
            throw new Error(response.message);
        }
        if (response.kind !== "stopped") {
            throw new Error("The Mobius manager returned an unexpected response");
        }
        await waitForManagerExit(stateDirectory, signal);
        return response;
    } catch (cause) {
        if (isNodeError(cause, "ENOENT") || isNodeError(cause, "ECONNREFUSED")) {
            return { kind: "stopped" };
        }
        throw cause;
    }
}

export async function runManager(
    installation: RuntimeInstallationStore,
    managerVersion: string,
    signal: AbortSignal,
): Promise<void> {
    const releaseLock = await acquireManagerLock(installation.stateDirectory);
    if (releaseLock === null) {
        return;
    }
    const socketPath = controlSocketPath(installation.stateDirectory);
    const shutdown = new AbortController();
    const combined = AbortSignal.any([signal, shutdown.signal]);
    const supervisor = new RuntimeSupervisor(installation, combined);
    const sockets = new Set<Socket>();
    let server: Server | undefined;
    try {
        const token = await readOrCreateControlToken(installation.stateDirectory);
        try {
            await supervisor.restore(combined);
        } catch (cause) {
            combined.throwIfAborted();
            process.stderr.write(`Could not restore saved Runtime connections: ${errorMessage(cause)}\n`);
        }
        if (combined.aborted) {
            return;
        }
        server = createServer((socket) => {
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            void (async () => {
                try {
                    const request = decodeCommand(await readSocketMessage(socket, combined), token);
                    let response: ManagerResponse;
                    if (request.kind === "list") {
                        response = { kind: "listed", managerVersion, pairs: supervisor.list() };
                    } else if (request.kind === "pair") {
                        const paired = await supervisor.pair(request.arguments, combined);
                        response = { alreadyOnline: paired.alreadyOnline, kind: "ready", pair: paired.pair };
                    } else if (request.kind === "start") {
                        response = {
                            alreadyOnline: false,
                            kind: "ready",
                            pair: await supervisor.start(request.arguments, combined),
                        };
                    } else if (request.kind === "stop-pair") {
                        response = {
                            kind: "pair-stopped",
                            pair: await supervisor.stop(request.connectionId, combined),
                        };
                    } else if (request.kind === "remove-pair") {
                        response = {
                            connectionId: await supervisor.remove(request.connectionId, combined),
                            kind: "pair-removed",
                        };
                    } else {
                        const beginShutdown = (): void => shutdown.abort();
                        socket.once("close", beginShutdown);
                        socket.once("error", beginShutdown);
                        socket.end(`${JSON.stringify({ kind: "stopped" })}\n`, beginShutdown);
                        return;
                    }
                    socket.end(`${JSON.stringify(response)}\n`);
                } catch (cause) {
                    socket.end(
                        `${JSON.stringify({ kind: "error", code: cause instanceof DaemonWorkerError ? cause.code : "manager_command_failed", message: errorMessage(cause) })}\n`,
                    );
                }
            })();
        });
        await managerPlatform.prepareControlSocket(socketPath);
        const listeningServer = server;
        await new Promise<void>((resolve, reject) => {
            listeningServer.once("listening", resolve);
            listeningServer.once("error", reject);
            listeningServer.listen(socketPath);
        });
        await managerPlatform.secureControlSocket(socketPath);
        if (!combined.aborted) {
            await new Promise<void>((resolve) => combined.addEventListener("abort", () => resolve(), { once: true }));
        }
    } finally {
        shutdown.abort();
        for (const socket of sockets) {
            socket.destroy();
        }
        const closingServer = server;
        if (closingServer?.listening) {
            await new Promise<void>((resolve) => closingServer.close(() => resolve()));
        }
        await supervisor.close();
        await managerPlatform.removeControlSocket(socketPath).catch(() => undefined);
        await releaseLock();
    }
}
