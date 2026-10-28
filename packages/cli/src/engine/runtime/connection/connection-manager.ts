import type {
    RuntimeConnectionActivation,
    RuntimeConnectionInput,
    VerifiedRuntimeConnection,
} from "./runtime-connection.ts";
import type { RuntimeInstallationStore } from "./runtime-installation-store.ts";

/** Saved connections; opening the installation remains an Engine responsibility. */
export class ConnectionManager {
    readonly #installation: (signal: AbortSignal) => Promise<RuntimeInstallationStore>;

    constructor(installation: (signal: AbortSignal) => Promise<RuntimeInstallationStore>) {
        this.#installation = installation;
    }

    readonly list = async (signal: AbortSignal): Promise<readonly VerifiedRuntimeConnection[]> =>
        await (await this.#installation(signal)).listConnections(signal);

    readonly read = async (connectionId: string, signal: AbortSignal): Promise<VerifiedRuntimeConnection> =>
        await (await this.#installation(signal)).readConnection(connectionId, signal);

    readonly save = async (input: RuntimeConnectionInput, signal: AbortSignal): Promise<VerifiedRuntimeConnection> =>
        await (await this.#installation(signal)).saveConnection(input, signal);

    readonly setActivation = async (
        connectionId: string,
        activation: RuntimeConnectionActivation,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> =>
        await (await this.#installation(signal)).setConnectionActivation(connectionId, activation, signal);

    readonly remove = async (connectionId: string, signal: AbortSignal): Promise<void> =>
        await (await this.#installation(signal)).removeConnection(connectionId, signal);
}
