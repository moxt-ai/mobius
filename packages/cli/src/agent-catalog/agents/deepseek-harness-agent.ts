import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type { AgentCapabilities, ClientConnection, InitializeResponse } from "@agentclientprotocol/sdk";

import { DEEPSEEK_HARNESS_PACKAGE } from "../../agent-installation/deepseek-managed-package.ts";
import { validateManagedNpmPackage } from "../../agent-installation/managed-npm-package.ts";
import type { ResolvedExecutable } from "../../process/executable.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import type { LocalAgentDiscoveryContext } from "../agent-discovery-context.ts";
import { AgentProbeError } from "../agent-probe-error.ts";
import { DirectAcpAgentDefinition } from "../agent-specification.ts";

// The DSH ACP bridge decides `promptCapabilities.image` once, from the provider and model pinned in
// its own plugin config, and never re-derives it when a caller changes the session model. The
// shipped ACP profile pins `deepseek-official/deepseek-v4-flash`, which is text only, so an
// untouched Agent home reports `image: false` and the composer can never offer an image control.
// DSH composes `$DSH_HOME/cordis.patch.yml` over every profile, so a managed Agent home pins the
// ACP bridge to the vision route the DeepSeek adapter already ships. Both keys are required: the
// pin is resolved through the provider adapter, so overriding only the model leaves the lookup
// unregistered. Only the managed Agent home is written; an unmanaged Agent home keeps whatever its
// owner configured.
const DEEPSEEK_HARNESS_IMAGE_PROMPT_PATCH = `# Managed by Mobius: pin the ACP bridge to an image-capable route.
- id: acp
  config:
    provider: deepseek-official
    model: deepseek-v4-flash-vision-exp
`;

async function prepareAgentHome(path: string, imagePrompts: boolean): Promise<string> {
    if (!isAbsolute(path) || normalize(path) !== path) {
        throw new AgentProbeError("agent_environment_invalid", "The configured Agent home is invalid");
    }
    try {
        // A managed Agent home starts out absent, so the managed call creates it before the shared
        // validation resolves it. An existing Agent home is never rewritten here.
        if (imagePrompts) {
            await mkdir(path, { mode: 0o700, recursive: true });
        }
        const resolved = await realpath(path);
        const metadata = await stat(resolved);
        if (!metadata.isDirectory() || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
            throw new Error("Agent home is not a user-owned directory");
        }
        if (imagePrompts) {
            await writeFile(join(resolved, "cordis.patch.yml"), DEEPSEEK_HARNESS_IMAGE_PROMPT_PATCH, {
                mode: 0o600,
            });
        }
        return resolved;
    } catch (error) {
        if (error instanceof AgentProbeError) {
            throw error;
        }
        throw new AgentProbeError("agent_environment_invalid", "The configured Agent home is invalid", {
            cause: error,
        });
    }
}

export class DeepSeekHarnessAgentSpecification extends DirectAcpAgentDefinition {
    readonly adapterVersion = DEEPSEEK_HARNESS_PACKAGE.version;
    override readonly authenticationCommand = (): string => "dsh web";
    readonly agentExecutable = "dsh";
    readonly id = "deepseek-harness";
    readonly label = "DeepSeek Harness";

    constructor() {
        super(
            "MOBIUS_DEEPSEEK_HARNESS_PATH",
            ["--profile", "acp"],
            [
                "agents",
                "deepseek-harness",
                DEEPSEEK_HARNESS_PACKAGE.version,
                "node_modules",
                "@deepseek-ai",
                "dsh",
                "lib",
                "bin.js",
            ],
        );
    }

    override readonly createLaunchEnvironment = async (
        agent: ResolvedExecutable,
        context: LocalAgentDiscoveryContext,
    ): Promise<Readonly<Record<string, string>>> => {
        let selectedHome = context.environment["DSH_HOME"];
        let managedHome = false;
        try {
            const managed = await this.resolveManagedAgent(
                readStateDirectory(context.environment),
                context.platform ?? process.platform,
                context.signal,
            );
            if (managed.path === agent.path) {
                selectedHome = join(readStateDirectory(context.environment), "agents", this.id, "home");
                managedHome = true;
            }
        } catch {
            context.signal.throwIfAborted();
            // An unavailable managed package cannot select the managed DSH home.
        }
        if (selectedHome === undefined || selectedHome.length === 0) {
            return Object.freeze({});
        }
        return Object.freeze({
            DSH_HOME: await prepareAgentHome(selectedHome, managedHome),
        });
    };

    override readonly resolveManagedAgent = async (
        stateDirectory: string,
        _platform: NodeJS.Platform,
        signal: AbortSignal,
    ): Promise<ResolvedExecutable> => {
        signal.throwIfAborted();
        const executable = await validateManagedNpmPackage(
            join(stateDirectory, "agents", this.id, DEEPSEEK_HARNESS_PACKAGE.version),
            DEEPSEEK_HARNESS_PACKAGE,
        );
        signal.throwIfAborted();
        return executable;
    };

    override readonly verifyAcp = (
        _connection: ClientConnection,
        initialized: InitializeResponse,
        _defaultWorkspace: string,
        _signal: AbortSignal,
    ): Promise<void> => {
        const capabilities: AgentCapabilities = initialized.agentCapabilities ?? {};
        const session = capabilities.sessionCapabilities;
        // Session capabilities are a hard compatibility contract: Mobius drives session listing,
        // resumption, and closing, so an adapter that omits or extends them cannot be attached.
        // Prompt capabilities are not a compatibility contract. They only describe which prompt
        // content the adapter currently accepts, which depends on the configured model route.
        // normalizeAcpCapabilities records them so the composer can offer exactly that content,
        // and the ACP session manager re-checks each capability before it builds a prompt. An
        // adapter that advertises image prompts is therefore attachable, and refusing it here
        // would be the one case that makes an advertised capability unrepresentable.
        if (
            (initialized.authMethods ?? []).length !== 0 ||
            capabilities.loadSession === true ||
            capabilities.mcpCapabilities?.http !== true ||
            session?.close == null ||
            session.list == null ||
            session.resume == null ||
            session.additionalDirectories != null ||
            session.delete != null ||
            session.fork != null
        ) {
            throw new AgentProbeError(
                "acp_incompatible",
                "DeepSeek Harness reported an unsupported ACP capability set",
            );
        }
        return Promise.resolve();
    };
}
