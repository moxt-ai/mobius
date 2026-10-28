import type {
    RuntimeConnectionActivation,
    RuntimeConnectionInput,
    VerifiedRuntimeConnection,
} from "./runtime-connection.ts";
import type { RuntimeInstallationStore } from "./runtime-installation-store.ts";

/** Saved connections; ensuring the installation exists remains an Engine responsibility. */
export class ConnectionManager {
    readonly #ensureInstallation: (signal: AbortSignal) => Promise<RuntimeInstallationStore>;

    constructor(ensureInstallation: (signal: AbortSignal) => Promise<RuntimeInstallationStore>) {
        this.#ensureInstallation = ensureInstallation;
    }

    readonly list = async (signal: AbortSignal): Promise<readonly VerifiedRuntimeConnection[]> =>
        await (await this.#ensureInstallation(signal)).listConnections(signal);

    readonly read = async (connectionId: string, signal: AbortSignal): Promise<VerifiedRuntimeConnection> =>
        await (await this.#ensureInstallation(signal)).readConnection(connectionId, signal);

    readonly save = async (input: RuntimeConnectionInput, signal: AbortSignal): Promise<VerifiedRuntimeConnection> =>
        await (await this.#ensureInstallation(signal)).saveConnection(input, signal);

    readonly setActivation = async (
        connectionId: string,
        activation: RuntimeConnectionActivation,
        signal: AbortSignal,
    ): Promise<VerifiedRuntimeConnection> =>
        await (await this.#ensureInstallation(signal)).setConnectionActivation(connectionId, activation, signal);

    readonly remove = async (connectionId: string, signal: AbortSignal): Promise<void> =>
        await (await this.#ensureInstallation(signal)).removeConnection(connectionId, signal);
}
