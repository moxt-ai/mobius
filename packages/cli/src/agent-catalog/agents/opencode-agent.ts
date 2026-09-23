import { join } from "node:path";

import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";
import type { SessionConfigOption } from "@moxt-ai/mobius-protocol";

import { AcpExecutionError } from "../../acp/acp-error.ts";
import { validateManagedAgentArchive } from "../../agent-installation/managed-agent-archive.ts";
import { OPENCODE_MANAGED_VERSION, openCodeManagedArchive } from "../../agent-installation/opencode-managed-release.ts";
import { type ResolvedExecutable, revalidateExecutable, runBoundedProcess } from "../../process/executable.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";
import type { AcpAgentDefinition } from "../local-agent.ts";

const MODEL_DISCOVERY_TIMEOUT_MILLISECONDS = 3_000;
const MODEL_DISCOVERY_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAXIMUM_MODEL_VALUES = 500;

function containsControlCharacter(value: string): boolean {
    return Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    });
}

async function discoverModelValues(
    agent: AcpAgentDefinition & { readonly kind: "acp-adapter-process" },
    cwd: string,
    signal: AbortSignal,
): Promise<readonly SessionConfigOption["values"][number][]> {
    if (!(await revalidateExecutable(agent.agentIdentity))) {
        throw new AcpExecutionError(
            "The local Agent runtime changed; restart Mobius before discovering settings",
            {},
            "agent_runtime_changed",
        );
    }
    const acpArgumentIndex = agent.arguments.indexOf("acp");
    if (acpArgumentIndex < 0) {
        throw new AcpExecutionError(
            "OpenCode does not expose its model discovery command",
            {},
            "invalid_session_configuration",
        );
    }
    const result = await runBoundedProcess({
        arguments: [
            ...agent.arguments.slice(0, acpArgumentIndex),
            "models",
            ...agent.arguments.slice(acpArgumentIndex + 1),
        ],
        command: agent.command,
        cwd,
        environment: { ...process.env, ...agent.environment },
        outputLimitBytes: MODEL_DISCOVERY_OUTPUT_LIMIT_BYTES,
        signal,
        timeoutMilliseconds: MODEL_DISCOVERY_TIMEOUT_MILLISECONDS,
    });
    const values: SessionConfigOption["values"][number][] = [];
    const identifiers = new Set<string>();
    for (const rawLine of result.stdout.split(/\r?\n/)) {
        const value = rawLine.trim();
        if (value.length === 0) {
            continue;
        }
        if (value.length > 512 || !/^[^\s/]+\/\S+$/.test(value) || containsControlCharacter(value)) {
            throw new AcpExecutionError(
                "OpenCode returned an invalid model catalog",
                {},
                "invalid_session_configuration",
            );
        }
        if (!identifiers.has(value)) {
            identifiers.add(value);
            values.push({ description: "", groupId: "", groupName: "", name: value, value });
        }
        if (values.length > MAXIMUM_MODEL_VALUES) {
            throw new AcpExecutionError("OpenCode returned too many models", {}, "invalid_session_configuration");
        }
    }
    return values;
}

function mergeModelValues(
    options: readonly SessionConfigOption[],
    discovered: readonly SessionConfigOption["values"][number][],
): readonly SessionConfigOption[] {
    if (discovered.length === 0) {
        return options;
    }
    return options.map((option) => {
        if ((option.id !== "model" && option.category !== "model") || option.type !== "select") {
            return option;
        }
        const known = new Map(option.values.map((value) => [value.value, value]));
        const values = discovered.map((value) => known.get(value.value) ?? value);
        const identifiers = new Set(values.map((value) => value.value));
        for (const value of option.values) {
            if (values.length >= MAXIMUM_MODEL_VALUES) {
                break;
            }
            if (!identifiers.has(value.value)) {
                identifiers.add(value.value);
                values.push(value);
            }
        }
        return { ...option, values };
    });
}

export async function discoverOpenCodeModelOptions(
    agent: AcpAgentDefinition,
    cwd: string,
    options: readonly SessionConfigOption[],
    signal: AbortSignal,
): Promise<readonly SessionConfigOption[]> {
    if (agent.id !== "opencode" || agent.kind !== "acp-adapter-process") {
        return options;
    }
    return mergeModelValues(options, await discoverModelValues(agent, cwd, signal));
}

export class OpenCodeAgentSpecification extends DirectAcpAgentDefinition {
    override readonly versionProbeTimeoutMilliseconds = 15_000;
    readonly adapterVersion = OPENCODE_MANAGED_VERSION;
    override readonly authenticationCommand = (): string => "opencode auth login";
    readonly agentExecutable = "opencode";
    readonly id = "opencode";
    readonly label = "OpenCode";

    constructor() {
        super(
            "MOBIUS_OPENCODE_PATH",
            ["acp"],
            [
                "agents",
                "opencode",
                OPENCODE_MANAGED_VERSION,
                "bin",
                process.platform === "win32" ? "opencode.exe" : "opencode",
            ],
        );
    }

    override readonly createLaunchEnvironment = async (
        _agent: ResolvedExecutable,
        context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => {
        const environment: Record<string, string> = { OPENCODE_DISABLE_AUTOUPDATE: "1" };
        const inlineConfiguration = context.environment["OPENCODE_CONFIG_CONTENT"];
        if (typeof inlineConfiguration === "string" && inlineConfiguration.length > 0) {
            environment["OPENCODE_CONFIG_CONTENT"] = inlineConfiguration;
        }
        return Object.freeze(environment);
    };

    override readonly resolveManagedAgent = async (
        stateDirectory: string,
        platform: NodeJS.Platform,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> =>
        await validateManagedAgentArchive(
            join(stateDirectory, "agents", this.id, OPENCODE_MANAGED_VERSION),
            openCodeManagedArchive(platform, process.arch),
            signal,
        );

    override readonly verifyAcp = (
        _connection: ClientConnection,
        initialized: InitializeResponse,
        _defaultWorkspace: string,
        _signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        const session = capabilities.sessionCapabilities;
        if (
            capabilities.loadSession !== true ||
            session?.close == null ||
            session.list == null ||
            session.resume == null
        ) {
            throw new AgentProbeError(
                "acp_incompatible",
                "OpenCode does not support the required ACP session lifecycle",
            );
        }
        return Promise.resolve();
    };
}
