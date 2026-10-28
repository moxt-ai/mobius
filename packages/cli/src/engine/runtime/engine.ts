import { resolve } from "node:path";
import { ConnectionManager } from "./connection/connection-manager.ts";
import type { VerifiedRuntimeConnection } from "./connection/runtime-connection.ts";
import { RuntimeInstallationStore } from "./connection/runtime-installation-store.ts";
import { type MobiusRuntimePairingOptions, pairRuntimeConnection, prepareRuntimeConnection } from "./pairing.ts";
import {
    type MobiusRuntimeConnection,
    prepareProvidedRuntime,
    RuntimeLoop,
    type RuntimeLoopOptions,
} from "./runtime-loop.ts";

export interface MobiusRuntimeEngineParams {
    readonly engineDataDir: string;
    readonly agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly maxAcpProcesses?: number;
}

export type EngineLoopConnection =
    | { readonly kind: "saved"; readonly connectionId: string }
    | { readonly kind: "provided"; readonly connection: MobiusRuntimeConnection };

export interface RunLoopParams extends RuntimeLoopOptions {
    readonly connection: EngineLoopConnection;
    readonly signal: AbortSignal;
}

export class MobiusRuntimeEngine {
    readonly #engineDataDir: string;
    readonly #agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly #maxAcpProcesses: number;
    readonly #connections: ConnectionManager;
    #installation: RuntimeInstallationStore | null = null;

    constructor(params: MobiusRuntimeEngineParams) {
        this.#engineDataDir = resolve(params.engineDataDir);
        this.#agentLaunchEnvironment = Object.freeze({ ...params.agentLaunchEnvironment });
        this.#maxAcpProcesses = params.maxAcpProcesses ?? 1000;
        this.#connections = new ConnectionManager(this.#getInstallation);
    }

    // Concurrent initializers use the store's atomic pointer creation. Only a successful,
    // non-cancelled open is cached, so one caller's cancellation cannot poison the Engine.
    readonly #getInstallation = async (signal: AbortSignal): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        if (this.#installation === null) {
            const installation = await RuntimeInstallationStore.open(this.#engineDataDir, signal);
            signal.throwIfAborted();
            this.#installation ??= installation;
        }
        return this.#installation;
    };

    readonly getConnectionManager = (): ConnectionManager => this.#connections;

    readonly pair = async (
        input: MobiusRuntimePairingOptions,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> =>
        await pairRuntimeConnection(await this.#getInstallation(signal), input, signal, this.#agentLaunchEnvironment);

    readonly runLoop = async ({ connection, signal, ...options }: RunLoopParams): Promise<void> => {
        const loop = new RuntimeLoop(async (preparationSignal) => {
            const installation = await this.#getInstallation(preparationSignal);
            switch (connection.kind) {
                case "saved": {
                    const saved = await installation.readConnection(connection.connectionId, preparationSignal);
                    return await prepareRuntimeConnection(
                        installation,
                        saved,
                        preparationSignal,
                        this.#agentLaunchEnvironment,
                        this.#maxAcpProcesses,
                    );
                }
                case "provided":
                    return await prepareProvidedRuntime({
                        installation,
                        connection: connection.connection,
                        signal: preparationSignal,
                        agentLaunchEnvironment: this.#agentLaunchEnvironment,
                        maxAcpProcesses: this.#maxAcpProcesses,
                    });
                default: {
                    const exhaustive: never = connection;
                    return exhaustive;
                }
            }
        }, options);
        await loop.run(signal);
    };
}

export type { ConnectionManager } from "./connection/connection-manager.ts";
export type { RuntimeConnectionInput, VerifiedRuntimeConnection } from "./connection/runtime-connection.ts";
export type { MobiusRuntimePairingOptions } from "./pairing.ts";
export { RuntimeRelayRevokedError } from "./relay/runtime-revocation.ts";
export type { MobiusRuntimeConnection } from "./runtime-loop.ts";
export { MobiusRuntimeConfigurationError } from "./runtime-loop.ts";
