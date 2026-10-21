import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionCommand } from "@moxt-ai/mobius-sdk/protocol";
import { AgentRuntimeManager, acpAdapters, NullAcpSessionObserver } from "../../../src/acp/agent-runtime-manager.ts";
import { AcpContentExternalizer } from "../../../src/acp/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../../src/acp/external-content/local-external-content-store.ts";
import { CodexAcpAgent } from "../../../src/acp/harness/codex/agent.ts";
import { MemoryAcpSessionStore } from "../../../src/acp/session-store.ts";
import { InProcessAcpAgentDefinition } from "../../../src/runtime/agent-catalog/local-agent.ts";
import { createRuntimeConfig } from "../../../src/runtime/config.ts";
import { NativeSessionService } from "../../../src/runtime/native-sessions/service.ts";
import { systemTimer } from "../../../src/runtime/relay/timer.ts";
import { WorkspaceDirectoryService } from "../../../src/runtime/workspace/workspace-directory.ts";
import { FakeOpenAiProvider } from "../llm/openai.ts";
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
    const sessions = new AgentRuntimeManager({
        observer: new NullAcpSessionObserver(),
        store,
        adapters: acpAdapters,
        sessionIdentity,
        onSessionStatusChanged: () => undefined,
        contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
        timer: systemTimer,
        maxProcesses: null,
    });
    const config = createRuntimeConfig(
        {
            defaultWorkspace: workspace,
            channelId: "test-channel",
            relayUrl: new URL("ws://localhost/"),
        },
        [agent],
    );
    const directories = new WorkspaceDirectoryService("workspace", workspace);
    const service = new NativeSessionService(config, directories, sessions, async () => ({
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
        });
    };
    const seed = async (title: string): Promise<string> => {
        const sessionId = await sessions.createNativeSession({
            agent,
            cwd: workspace,
            additionalDirectories: [],
            sessionId: identity.sessionId,
            signal: AbortSignal.timeout(30_000),
        });
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
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
        await rm(temporary, { recursive: true, force: true });
    };
    return { agent, identity, list, seed, prompt, sessions, service, workspace, close };
}
