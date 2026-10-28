import { resolve } from "node:path";
import { waitForSharedOperation } from "../session/manager/operation-drain.ts";
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

type InstallationState =
    | { readonly kind: "uninitialized" }
    | { readonly kind: "initializing"; readonly completion: Promise<void> }
    | { readonly kind: "ready"; readonly installation: RuntimeInstallationStore };

export class MobiusRuntimeEngine {
    readonly #engineDataDir: string;
    readonly #agentLaunchEnvironment: Readonly<NodeJS.ProcessEnv>;
    readonly #maxAcpProcesses: number;
    readonly #connections: ConnectionManager;
    #installation: InstallationState = { kind: "uninitialized" };

    constructor(params: MobiusRuntimeEngineParams) {
        this.#engineDataDir = resolve(params.engineDataDir);
        this.#agentLaunchEnvironment = Object.freeze({ ...params.agentLaunchEnvironment });
        this.#maxAcpProcesses = params.maxAcpProcesses ?? 1000;
        this.#connections = new ConnectionManager(this.#getInstallation);
    }

    readonly #getInstallation = async (signal: AbortSignal): Promise<RuntimeInstallationStore> => {
        signal.throwIfAborted();
        const state = this.#installation;
        switch (state.kind) {
            case "ready":
                return state.installation;
            case "initializing":
                // A borrower can stop waiting without cancelling the owner. If the owner
                // fails or cancels, a surviving borrower can become the next initializer.
                await waitForSharedOperation(state.completion, signal);
                return await this.#getInstallation(signal);
            case "uninitialized": {
                const completion = Promise.withResolvers<void>();
                // Claim initialization before the first filesystem await. Exclusive file
                // creation alone does not prevent another opener from reading partial JSON.
                this.#installation = { kind: "initializing", completion: completion.promise };
                try {
                    const installation = await RuntimeInstallationStore.open(this.#engineDataDir, signal);
                    signal.throwIfAborted();
                    this.#installation = { kind: "ready", installation };
                    return installation;
                } catch (cause) {
                    this.#installation = { kind: "uninitialized" };
                    signal.throwIfAborted();
                    throw cause;
                } finally {
                    completion.resolve();
                }
            }
            default: {
                const exhaustive: never = state;
                return exhaustive;
            }
        }
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
