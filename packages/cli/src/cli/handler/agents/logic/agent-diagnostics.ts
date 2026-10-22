import {
    type AvailableAgent,
    type LocalAgentInventory,
    MissingAdapter,
    type UnavailableAgent,
    UnsupportedAgentVersion,
} from "../../../../agent/discovery/agent-discovery.ts";

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

class UnsupportedAgentVersionDiagnostic extends UnavailableAgentDiagnostic {
    readonly agentVersion: string;
    readonly minimumSupportedVersion: string;

    constructor(discovery: UnsupportedAgentVersion) {
        super(discovery);
        this.agentVersion = discovery.agentVersion;
        this.minimumSupportedVersion = discovery.minimumSupportedVersion;
    }
}

type TimedDiagnostic<T> = T & { readonly detectionMilliseconds: number };

function withDetectionTime<T extends object>(
    diagnostic: T,
    detectionMilliseconds: number,
    verbose: boolean,
): T | TimedDiagnostic<T> {
    return verbose ? { ...diagnostic, detectionMilliseconds } : diagnostic;
}

function unavailableDiagnostic(discovery: UnavailableAgent): UnavailableAgentDiagnostic {
    return discovery instanceof UnsupportedAgentVersion
        ? new UnsupportedAgentVersionDiagnostic(discovery)
        : new UnavailableAgentDiagnostic(discovery);
}

class AgentDiagnostics {
    readonly available: readonly (AvailableAgentDiagnostic | TimedDiagnostic<AvailableAgentDiagnostic>)[];
    readonly unavailable: readonly (UnavailableAgentDiagnostic | TimedDiagnostic<UnavailableAgentDiagnostic>)[];

    constructor(inventory: LocalAgentInventory, verbose: boolean) {
        this.available = inventory.available.map((discovery) =>
            withDetectionTime(
                new AvailableAgentDiagnostic(discovery),
                inventory.detectionMillisecondsFor(discovery),
                verbose,
            ),
        );
        this.unavailable = inventory.unavailable.map((discovery) =>
            withDetectionTime(unavailableDiagnostic(discovery), inventory.detectionMillisecondsFor(discovery), verbose),
        );
    }
}

function humanLine(label: string, status: string, detail: string): string {
    return `${label.padEnd(13)} ${status.padEnd(17)} ${detail}`.trimEnd();
}

function detectionSuffix(diagnostic: object): string {
    if (!("detectionMilliseconds" in diagnostic) || typeof diagnostic.detectionMilliseconds !== "number") {
        return "";
    }
    return `   detection=${Math.round(diagnostic.detectionMilliseconds).toString()}ms`;
}

export function formatAgentDiagnostics(inventory: LocalAgentInventory, json: boolean, verbose = false): string {
    const diagnostics = new AgentDiagnostics(inventory, verbose);
    if (json) {
        return `${JSON.stringify(diagnostics, null, 2)}\n`;
    }

    const lines: string[] = [];
    for (const available of diagnostics.available) {
        lines.push(
            humanLine(
                available.label,
                available.status,
                `${available.agentVersion}   ${available.adapterVersion}${detectionSuffix(available)}`,
            ),
        );
    }
    for (const unavailable of diagnostics.unavailable) {
        lines.push(
            humanLine(unavailable.label, unavailable.status, `${unavailable.message}${detectionSuffix(unavailable)}`),
        );
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
