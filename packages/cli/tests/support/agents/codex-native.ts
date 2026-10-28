import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionCommand } from "@moxt-ai/mobius-sdk/protocol";
import { CodexAgentConnection } from "../../../src/engine/acp/adapter/codex/agent-connection.ts";
import { AcpAgentDefinition } from "../../../src/engine/acp/agent/agent-definition.ts";
import { AcpContentExternalizer } from "../../../src/engine/acp/content/content-externalizer.ts";
import type { AdapterResolver } from "../../../src/engine/acp/native-history/preview-contract.ts";
import { RuntimeAgentDependencies } from "../../../src/engine/agent/runtime-agents.ts";
import { createRuntimeConfig } from "../../../src/engine/runtime/config.ts";
import { NullSessionObserver } from "../../../src/engine/session/api/session-api.ts";
import { NativeSessionService } from "../../../src/engine/session/native/native-session-browser.ts";
import { MemorySessionStore } from "../../../src/engine/session/record/session-store.ts";
import { WorkspaceDirectoryService } from "../../../src/engine/session/workspace/workspace-directory.ts";
import { systemTimer } from "../../../src/engine/util/timer.ts";
import { acpAdapters } from "../acp-adapters.ts";
import { FakeOpenAiProvider } from "../llm/openai.ts";
import { SessionRuntimeFixture as SessionManager } from "../session-runtime.ts";
import { UnretainedExternalContentStore } from "../unretained-external-content-store.ts";
import { CodexFixture } from "./codex.ts";

export async function codexFixture(
    sessionIdentity: "assigned" | "native" = "assigned",
    answer = "REAL_CODEX_REPLY",
    providerOptions: Parameters<typeof FakeOpenAiProvider.start>[2] = {},
    adapters: AdapterResolver = acpAdapters,
) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "mobius-native-codex-")));
    const workspace = join(temporary, "workspace");
    await mkdir(workspace);
    const provider = await FakeOpenAiProvider.start("mobius-test-model", answer, providerOptions);
    const codex = await CodexFixture.create(provider);
    const agent = new AcpAgentDefinition(
        "codex",
        "Codex",
        codex.executable,
        (options) => new CodexAgentConnection(options),
        codex.environment,
    );
    const store = new MemorySessionStore();
    const sessions = new SessionManager({
        observer: new NullSessionObserver(),
        store,
        adapters,
        sessionIdentity,
        onSessionStatusChanged: () => undefined,
        contentExternalizer: new AcpContentExternalizer((sessionId, content, signal) =>
            new UnretainedExternalContentStore().put({
                bytes: content.bytes,
                kind: content.kind,
                mediaType: content.mediaType,
                name: content.name,
                sessionId,
                signal,
            }),
        ),
        timer: systemTimer,
        maxProcesses: null,
    });
    const config = createRuntimeConfig(
        {
            defaultWorkspace: workspace,
            channelId: "test-channel",
            relayUrl: new URL("ws://localhost/"),
        },
        new RuntimeAgentDependencies([agent]),
    );
    const directories = new WorkspaceDirectoryService("workspace", workspace);
    const service = new NativeSessionService(
        config.bindingId,
        (agentId) => sessions.resolveAgent(config.catalog.find(agentId)),
        directories,
        sessions.sessions,
        async () => ({
            turn: null,
            queued: [],
        }),
    );
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
        await service.close();
        await sessions.close();
        await codex[Symbol.asyncDispose]();
        await provider[Symbol.asyncDispose]();
        await rm(temporary, { recursive: true, force: true });
    };
    return { agent, identity, list, seed, prompt, sessions, service, workspace, close };
}
