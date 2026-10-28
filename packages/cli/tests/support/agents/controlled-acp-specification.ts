import type { AgentConnectionFactory } from "../../../src/engine/acp/connection/agent-connection.ts";
import { LocalAgentSpecification } from "../../../src/engine/agent/specification/agent-specification.ts";
import { ControlledAcpConnection } from "./controlled-acp-connection.ts";

/** Discovery fixture for controlled peers that expose ACP on stdio. */
export abstract class ControlledAcpSpecification extends LocalAgentSpecification {
    readonly adapterOverrideVariable: string;
    readonly agentOverrideVariable: string;
    readonly launchArguments: readonly string[];
    readonly createConnection: AgentConnectionFactory = (options) =>
        new ControlledAcpConnection(
            {
                id: this.id,
                adapterPath: options.command,
                arguments: this.launchArguments,
                environment: options.environment,
            },
            options,
        );

    protected constructor(executableOverrideVariable: string, launchArguments: readonly string[]) {
        super();
        this.adapterOverrideVariable = executableOverrideVariable;
        this.agentOverrideVariable = executableOverrideVariable;
        this.launchArguments = Object.freeze([...launchArguments]);
    }
}
