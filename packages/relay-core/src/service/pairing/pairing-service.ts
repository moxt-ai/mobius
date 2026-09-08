import type { PairingGateway } from "../../gateway/index.ts";
import type { AgentDescriptor, InstallableAgentDescriptor } from "./pairing.ts";

export class PairingService {
    static readonly inject = ["pairingGateway"] satisfies readonly ["pairingGateway"];

    readonly #pairings: PairingGateway;

    constructor(pairings: PairingGateway) {
        this.#pairings = pairings;
    }

    readonly createPairing = (signal: AbortSignal) => this.#pairings.createPairing(signal);

    readonly readPairingStatus = (pairingId: string, pollToken: string, signal: AbortSignal) =>
        this.#pairings.readPairingStatus(pairingId, pollToken, signal);

    readonly claimPairing = (
        pairingCode: string,
        machineName: string,
        workspaceName: string,
        agents: readonly AgentDescriptor[],
        installableAgents: readonly InstallableAgentDescriptor[],
        signal: AbortSignal,
    ) => this.#pairings.claimPairing(pairingCode, machineName, workspaceName, agents, installableAgents, signal);
}
