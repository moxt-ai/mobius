import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import type { ExecutableIdentity } from "../../util/process/executable.ts";
import { readExecutableIdentity } from "../../util/process/local-executable.ts";
import { unsupportedSessionCapabilities } from "../protocol/session-capabilities.ts";
import type { InProcessAcpEndpointFactory } from "./in-process-endpoint.ts";

abstract class AgentDefinition {
    readonly agentIdentity: ExecutableIdentity;
    readonly agentVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly id: string;
    readonly label: string;

    protected constructor(
        id: string,
        label: string,
        _command: string,
        environment: Readonly<Record<string, string>>,
        agentVersion: string,
        agentIdentity: ExecutableIdentity,
        capabilities: SessionCapabilities,
    ) {
        this.agentIdentity = agentIdentity;
        this.agentVersion = agentVersion;
        this.capabilities = Object.freeze({ ...capabilities });
        this.command = agentIdentity.realPath;
        this.environment = Object.freeze({ ...environment });
        this.id = id;
        this.label = label;
    }

    abstract readonly withEnvironment: (environment: Readonly<Record<string, string>>) => AcpAgentDefinition;
}

// A vendor CLI that speaks ACP only through a separate adapter process. Mobius spawns the adapter,
// and the vendor binary is handed to it through an environment variable.
export class LocalAgentDefinition extends AgentDefinition {
    readonly kind = "acp-adapter-process";
    readonly adapterIdentity: ExecutableIdentity;
    readonly adapterPath: string;
    readonly adapterVersion: string;
    readonly arguments: readonly string[];

    constructor(
        id: string,
        label: string,
        command: string,
        arguments_: readonly string[],
        environment: Readonly<Record<string, string>> = {},
        adapterVersion = "",
        agentVersion = "",
        adapterIdentity: ExecutableIdentity = readExecutableIdentity(command),
        agentIdentity: ExecutableIdentity = adapterIdentity,
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
    ) {
        super(id, label, command, environment, agentVersion, agentIdentity, capabilities);
        this.adapterIdentity = adapterIdentity;
        this.adapterPath = adapterIdentity.realPath;
        this.adapterVersion = adapterVersion;
        this.arguments = Object.freeze([...arguments_]);
    }

    override readonly withEnvironment = (environment: Readonly<Record<string, string>>): LocalAgentDefinition =>
        new LocalAgentDefinition(
            this.id,
            this.label,
            this.command,
            this.arguments,
            environment,
            this.adapterVersion,
            this.agentVersion,
            this.adapterIdentity,
            this.agentIdentity,
            this.capabilities,
        );
}

// A vendor CLI that Mobius drives through the vendor's own protocol from an ACP Agent hosted inside
// the daemon. There is no adapter process. `command` is the vendor binary the endpoint spawns, and
// `createEndpoint` is how the daemon builds that Agent without naming a vendor.
export class InProcessAcpAgentDefinition extends AgentDefinition {
    readonly kind = "in-process-acp";
    readonly createEndpoint: InProcessAcpEndpointFactory;

    constructor(
        id: string,
        label: string,
        command: string,
        createEndpoint: InProcessAcpEndpointFactory,
        environment: Readonly<Record<string, string>> = {},
        agentVersion = "",
        agentIdentity: ExecutableIdentity = readExecutableIdentity(command),
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
    ) {
        super(id, label, command, environment, agentVersion, agentIdentity, capabilities);
        this.createEndpoint = createEndpoint;
    }

    override readonly withEnvironment = (environment: Readonly<Record<string, string>>): InProcessAcpAgentDefinition =>
        new InProcessAcpAgentDefinition(
            this.id,
            this.label,
            this.command,
            this.createEndpoint,
            environment,
            this.agentVersion,
            this.agentIdentity,
            this.capabilities,
        );
}

// A ready Agent Mobius can start a session against. The variant decides how the ACP connection is
// established: an adapter child process, or an in-process agent over the vendor's own protocol.
export type AcpAgentDefinition = LocalAgentDefinition | InProcessAcpAgentDefinition;
