import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionCommand } from "@moxt-ai/mobius-protocol";
import { AgentRuntimeManager, NullAcpSessionObserver } from "../../../packages/cli/src/acp/agent-runtime-manager.ts";
import { CodexAcpAgent } from "../../../packages/cli/src/acp/codex/agent.ts";
import { MemoryAcpSessionStore } from "../../../packages/cli/src/acp/session-store.ts";
import { InProcessAcpAgentDefinition } from "../../../packages/cli/src/agent-catalog/local-agent.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { WorkspaceDirectoryService } from "../../../packages/cli/src/authorization/workspace-directory.ts";
import { createDaemonConfig } from "../../../packages/cli/src/config.ts";
import { NativeSessionService } from "../../../packages/cli/src/native-sessions/service.ts";
import { FakeOpenAiProvider } from "../providers/openai.ts";
import { CodexFixture } from "./codex.ts";

export async function codexFixture(
    sessionIdentity: "assigned" | "native" = "assigned",
    answer = "REAL_CODEX_REPLY",
    providerOptions: Parameters<typeof FakeOpenAiProvider.start>[2] = {},
) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "mobius-native-codex-")));
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    const provider = await FakeOpenAiProvider.start("mobius-test-model", answer, providerOptions);
    const codex = await CodexFixture.create(provider);
    const agent = new InProcessAcpAgentDefinition(
        "codex",
        "Codex",
        codex.executable,
        (options) => new CodexAcpAgent(options),
        codex.environment,
    );
    const store = new MemoryAcpSessionStore();
    const sessions = new AgentRuntimeManager(new NullAcpSessionObserver(), store, null, sessionIdentity);
    const audit = new AuditStore();
    const config = createDaemonConfig(
        {
            defaultWorkspace: workspace,
            channelId: "test-channel",
            relayUrl: new URL("ws://localhost/"),
        },
        [agent],
    );
    const directories = new WorkspaceDirectoryService("workspace", workspace);
    const service = new NativeSessionService(config, directories, sessions, audit, async () => ({
        turn: null,
        queued: [],
    }));
    const identity = {
        additionalDirectoryIds: [],
        agentId: agent.id,
        bindingId: "workspace",
        directoryId: "default",
        kind: "native.session.request",
        requestId: "native-operation",
        sessionId: "browser",
    } satisfies Omit<NativeSessionCommand, "action">;
    const prompt = async (sessionId: string, text: string): Promise<void> => {
        await sessions.runPrompt({
            agent,
            cwd: workspace,
            additionalDirectories: [],
            sessionId,
            commandId: crypto.randomUUID(),
            prompt: text,
            images: [],
            resources: [],
            signal: AbortSignal.timeout(30_000),
            onText: async () => {},
            onActivity: async () => {},
        });
    };
    const seed = async (title: string): Promise<string> => {
        const created = await service.execute({ ...identity, action: "create" }, AbortSignal.timeout(30_000));
        if (created.action !== "create") {
            throw new Error("Expected native Codex creation");
        }
        const sessionId = created.nativeSessionId;
        await prompt(sessionId, title);
        return sessionId;
    };
    const list = async (cursor: string | null = null) => {
        const result = await service.execute({ ...identity, action: "list", cursor }, AbortSignal.timeout(30_000));
        if (result.action !== "list") {
            throw new Error("Expected a native session list");
        }
        return result;
    };
    const close = async (): Promise<void> => {
        await sessions.close();
        audit.close();
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
        await rm(temporary, { recursive: true, force: true });
    };
    return { agent, identity, list, seed, prompt, sessions, service, workspace, close };
}
