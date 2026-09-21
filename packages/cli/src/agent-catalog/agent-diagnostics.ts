import {
    type AvailableAgent,
    type LocalAgentInventory,
    MissingAdapter,
    type UnavailableAgent,
} from "./agent-discovery.ts";

class AvailableAgentDiagnostic {
    readonly adapterVersion: string;
    readonly agentVersion: string;
    readonly id: string;
    readonly label: string;
    readonly status = "ready";

    constructor(discovery: AvailableAgent) {
        this.adapterVersion =
            discovery.agent.kind === "acp-adapter-process"
                ? discovery.agent.adapterVersion
                : discovery.agent.agentVersion;
        this.agentVersion = discovery.agent.agentVersion;
        this.id = discovery.specification.id;
        this.label = discovery.specification.label;
    }
}

class UnavailableAgentDiagnostic {
    readonly code: string;
    readonly id: string;
    readonly label: string;
    readonly message: string;
    readonly recoveryCommand: string;
    readonly status: string;

    constructor(discovery: UnavailableAgent) {
        this.code = discovery.code;
        this.id = discovery.specification.id;
        this.label = discovery.specification.label;
        this.message = discovery.message;
        this.recoveryCommand =
            discovery instanceof MissingAdapter
                ? discovery.specification.recoveryCommand()
                : discovery.code === "authentication_required"
                  ? discovery.specification.authenticationCommand()
                  : "";
        this.status = discovery.status;
    }
}

class AgentDiagnostics {
    readonly available: readonly AvailableAgentDiagnostic[];
    readonly unavailable: readonly UnavailableAgentDiagnostic[];

    constructor(inventory: LocalAgentInventory) {
        this.available = inventory.available.map((discovery) => new AvailableAgentDiagnostic(discovery));
        this.unavailable = inventory.unavailable.map((discovery) => new UnavailableAgentDiagnostic(discovery));
    }
}

function humanLine(label: string, status: string, detail: string): string {
    return `${label.padEnd(13)} ${status.padEnd(17)} ${detail}`.trimEnd();
}

export function formatAgentDiagnostics(inventory: LocalAgentInventory, json: boolean): string {
    const diagnostics = new AgentDiagnostics(inventory);
    if (json) {
        return `${JSON.stringify(diagnostics, null, 2)}\n`;
    }

    const lines: string[] = [];
    for (const available of diagnostics.available) {
        lines.push(
            humanLine(available.label, available.status, `${available.agentVersion}   ${available.adapterVersion}`),
        );
    }
    for (const unavailable of diagnostics.unavailable) {
        lines.push(humanLine(unavailable.label, unavailable.status, unavailable.message));
        if (unavailable.recoveryCommand.length > 0) {
            lines.push(
                unavailable.code === "authentication_required"
                    ? `  Authenticate locally: ${unavailable.recoveryCommand}`
                    : `  Install adapter: ${unavailable.recoveryCommand}`,
            );
        }
    }
    return `${lines.join("\n")}\n`;
}
