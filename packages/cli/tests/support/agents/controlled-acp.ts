import { DirectAcpAgentDefinition } from "../../../src/agent-catalog/agent-specification.ts";

const CONTROLLED_ACP_VERSION = "1.0.0";

export class ControlledAcpAgentSpecification extends DirectAcpAgentDefinition {
    readonly adapterVersion = CONTROLLED_ACP_VERSION;
    readonly agentExecutable = "controlled-acp";
    readonly id = "controlled-acp";
    readonly label = "Controlled ACP";
    override readonly maximumTestedAgentVersion = this.adapterVersion;
    override readonly minimumSupportedAgentVersion = this.adapterVersion;

    constructor() {
        super("MOBIUS_TEST_CONTROLLED_ACP_PATH", []);
    }
}
