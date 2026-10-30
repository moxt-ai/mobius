import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import type { ExecutableIdentity } from "../../util/process/executable.ts";
import { readExecutableIdentity } from "../../util/process/local-executable.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type {
    AgentConnection,
    AgentConnectionFactory,
    AgentConnectionOptions,
} from "../connection/agent-connection.ts";
import { unsupportedSessionCapabilities } from "../protocol/session-capabilities.ts";

/** A verified local Agent. Its adapter owns how connections are established. */
export class AcpAgentDefinition {
    readonly agentIdentity: ExecutableIdentity;
    readonly agentVersion: string;
    readonly adapterVersion: string;
    readonly capabilities: SessionCapabilities;
    readonly command: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly id: string;
    readonly label: string;
    readonly runtimeExecutables: readonly ExecutableIdentity[];
    readonly #connectionFactory: AgentConnectionFactory | null;

    constructor(
        id: string,
        label: string,
        command: string,
        createConnection: AgentConnectionFactory | null,
        environment: Readonly<Record<string, string>> = {},
        agentVersion = "",
        agentIdentity: ExecutableIdentity = readExecutableIdentity(command),
        capabilities: SessionCapabilities = unsupportedSessionCapabilities(),
        adapterVersion = agentVersion,
        runtimeExecutables: readonly ExecutableIdentity[] = [agentIdentity],
    ) {
        this.agentIdentity = agentIdentity;
        this.agentVersion = agentVersion;
        this.adapterVersion = adapterVersion;
        this.capabilities = Object.freeze({ ...capabilities });
        this.command = agentIdentity.realPath;
        this.environment = Object.freeze({ ...environment });
        this.id = id;
        this.label = label;
        this.runtimeExecutables = Object.freeze([...new Set([agentIdentity, ...runtimeExecutables])]);
        this.#connectionFactory = createConnection;
    }

    readonly createConnection = (options: AgentConnectionOptions): AgentConnection => {
        if (this.#connectionFactory === null) {
            throw new AcpExecutionError("This Agent uses its native harness", {}, "acp_connection_unsupported");
        }
        return this.#connectionFactory({ ...options, command: this.command, environment: this.environment });
    };

    readonly withEnvironment = (environment: Readonly<Record<string, string>>): AcpAgentDefinition =>
        new AcpAgentDefinition(
            this.id,
            this.label,
            this.command,
            this.#connectionFactory,
            environment,
            this.agentVersion,
            this.agentIdentity,
            this.capabilities,
            this.adapterVersion,
            this.runtimeExecutables,
        );
}
