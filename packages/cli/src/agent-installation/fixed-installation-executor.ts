import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentInstallationStage } from "@moxt-ai/mobius-protocol";

import { AvailableAgent, MissingAgent } from "../agent-catalog/agent-discovery.ts";
import type { LocalAgentSpecification } from "../agent-catalog/agent-specification.ts";
import { supportedLocalAgentSpecifications } from "../agent-catalog/agents/supported-agent-specifications.ts";
import { discoverLocalAgentInventory } from "../agent-catalog/discover-local-agents.ts";
import { findVerifiedAgentExecutable } from "../agent-catalog/executable-discovery.ts";
import type { LocalAgentCatalog } from "../agent-catalog/local-agent.ts";
import { withDaemonEnvironment } from "../config.ts";
import type { InstallationAudit, InstallationExecutor } from "./agent-installation-manager.ts";
import { InstallationManagerError } from "./agent-installation-manager.ts";

export interface FixedInstallationExecutorOptions {
    readonly defaultWorkspace: string;
    readonly audit?: InstallationAudit;
    readonly catalog: LocalAgentCatalog;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly publishCatalog: (signal: AbortSignal) => Promise<void>;
}

const nullInstallationAudit: InstallationAudit = {
    record: () => undefined,
};

function findSpecification(
    specifications: readonly LocalAgentSpecification[],
    agentId: string,
): LocalAgentSpecification {
    for (const specification of specifications) {
        if (specification.id === agentId) {
            return specification;
        }
    }
    throw new InstallationManagerError("unknown_agent", "The requested Agent is not supported");
}

function resolveDefaultWorkspace(path: string): string {
    try {
        const directory = realpathSync(resolve(path));
        if (!statSync(directory).isDirectory()) {
            throw new Error("Default workspace is not a directory");
        }
        return directory;
    } catch (error) {
        throw new InstallationManagerError(
            "unsafe_installation_root",
            "The default workspace is unavailable or unsafe",
            { cause: error },
        );
    }
}

function translateExecutionError(error: unknown): InstallationManagerError {
    if (error instanceof InstallationManagerError) {
        return error;
    }
    return new InstallationManagerError("installation_failed", "The local Agent integration installation failed", {
        cause: error,
    });
}

export class FixedInstallationExecutor implements InstallationExecutor {
    readonly #defaultWorkspace: string;
    readonly #audit: InstallationAudit;
    readonly #catalog: LocalAgentCatalog;
    readonly #environment: Readonly<NodeJS.ProcessEnv>;
    readonly #publishCatalog: (signal: AbortSignal) => Promise<void>;
    readonly #specifications: readonly LocalAgentSpecification[];

    constructor(
        options: FixedInstallationExecutorOptions,
        specifications: readonly LocalAgentSpecification[] = supportedLocalAgentSpecifications(),
    ) {
        const defaultWorkspace = resolveDefaultWorkspace(options.defaultWorkspace);
        this.#defaultWorkspace = defaultWorkspace;
        this.#audit = options.audit ?? nullInstallationAudit;
        this.#catalog = options.catalog;
        this.#environment = Object.freeze({ ...options.environment });
        this.#publishCatalog = options.publishCatalog;
        this.#specifications = Object.freeze([...specifications]);
    }

    readonly execute = async (
        agentId: string,
        requestId: string,
        report: (stage: AgentInstallationStage) => Promise<void>,
        signal: AbortSignal,
    ): Promise<void> => {
        try {
            const specification = findSpecification(this.#specifications, agentId);
            const discoveryOptions = {
                defaultWorkspace: this.#defaultWorkspace,
                environment: this.#environment,
                signal,
            };
            const initialInventory = await discoverLocalAgentInventory({
                ...discoveryOptions,
                specifications: [specification],
            });
            await this.#publishDiscoveredAgent(agentId, initialInventory, this.#environment, signal);

            const alreadyReady = initialInventory.available.find((candidate) => candidate.specification.id === agentId);
            if (alreadyReady instanceof AvailableAgent) {
                return;
            }
            const initialDiscovery = initialInventory.unavailable.find(
                (candidate) => candidate.specification.id === agentId,
            );
            if (initialDiscovery instanceof MissingAgent) {
                throw new InstallationManagerError(
                    "agent_not_installed",
                    `Install ${specification.label} on this machine, then check local Agents again.`,
                );
            }
            const verifiedAgent = await findVerifiedAgentExecutable(specification, discoveryOptions);
            if (verifiedAgent === null) {
                throw new InstallationManagerError(
                    "agent_not_installed",
                    `Install ${specification.label} on this machine, then check local Agents again.`,
                );
            }
            const agent = verifiedAgent.executable;
            await report("checking_acp");
            const environment: NodeJS.ProcessEnv = { ...this.#environment };
            environment[specification.agentOverrideVariable] = agent.identity.requestedPath;
            environment[specification.adapterOverrideVariable] = agent.identity.requestedPath;
            const inventory = await discoverLocalAgentInventory({
                defaultWorkspace: this.#defaultWorkspace,
                environment,
                signal,
                specifications: [specification],
            });
            const verified = inventory.available.find((candidate) => candidate.specification.id === agentId);
            if (verified instanceof AvailableAgent) {
                this.#audit.record("agent_installation_acp_verified", requestId, agentId, {
                    adapterVersion:
                        verified.agent.kind === "acp-adapter-process"
                            ? verified.agent.adapterVersion
                            : verified.agent.agentVersion,
                    agentVersion: verified.agent.agentVersion,
                });

                await this.#publishDiscoveredAgent(agentId, inventory, environment, signal);
                return;
            }

            const unavailable = inventory.unavailable.find((candidate) => candidate.specification.id === agentId);
            if (unavailable === undefined) {
                throw new InstallationManagerError(
                    "agent_verification_failed",
                    "The complete Agent ACP path did not pass verification",
                );
            }
            throw new InstallationManagerError(unavailable.code, unavailable.message);
        } catch (error) {
            if (signal.aborted) {
                signal.throwIfAborted();
            }
            throw translateExecutionError(error);
        }
    };

    readonly #publishDiscoveredAgent = async (
        agentId: string,
        inventory: Awaited<ReturnType<typeof discoverLocalAgentInventory>>,
        environment: Readonly<NodeJS.ProcessEnv>,
        signal: AbortSignal,
    ): Promise<void> => {
        const previous = this.#catalog.read();
        this.#catalog.transition(
            [
                ...previous.agents.filter((agent) => agent.id !== agentId),
                ...inventory.readyAgents().map((agent) => withDaemonEnvironment(agent, environment)),
            ],
            [...previous.installableAgents.filter((agent) => agent.id !== agentId), ...inventory.installable],
        );
        try {
            await this.#publishCatalog(signal);
        } catch (error) {
            this.#catalog.transition(previous.agents, previous.installableAgents);
            throw error;
        }
    };
}
