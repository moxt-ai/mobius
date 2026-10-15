import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpSessionUpdateV2, NativeSessionCommand, SessionLiveEventV2 } from "@moxt-ai/mobius-protocol";
import { AgentRuntimeManager, NullAcpSessionObserver } from "../../src/acp/agent-runtime-manager.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { acpHarnessNativeHistoryReader, type HarnessNativeHistoryReader } from "../../src/adapter/harness-adapter.ts";
import { HarnessAdapterRegistry } from "../../src/adapter/harness-adapter-registry.ts";
import { AuditStore } from "../../src/audit/audit-store.ts";
import { WorkspaceDirectoryService } from "../../src/authorization/workspace-directory.ts";
import { createDaemonConfig, LocalAgentDefinition } from "../../src/config.ts";
import { NativeSessionService } from "../../src/native-sessions/service.ts";

const acpUrl = new URL("./fixtures/acp-peer.ts", import.meta.url).toString();

// Real providers cannot deterministically supply destructive test sessions or stalled
// loads. These ACP subprocesses maintain their own disposable session files.
class NativeSessionObserver extends NullAcpSessionObserver {
    readonly updates: AcpSessionUpdateV2[] = [];
    readonly loading = Promise.withResolvers<void>();
    override readonly onSessionEventV2 = (event: SessionLiveEventV2): Promise<void> => {
        if (event.type === "acp") {
            this.updates.push(event.payload);
        }
        return Promise.resolve();
    };
    override readonly onInfo = async (): Promise<void> => {
        this.loading.resolve();
    };
}

export async function fixture(
    label: string,
    profile:
        | "load-only"
        | "replay-history-once"
        | "supported"
        | "unsupported"
        | "invalid-fork"
        | "exclusive-writer"
        | "persist-after-first-prompt" = "supported",
    sessionIdentity: "assigned" | "native" = "assigned",
    nativeHistoryReader: HarnessNativeHistoryReader = acpHarnessNativeHistoryReader,
) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "mobius-native-boundary-")));
    const workspace = join(temporary, "workspace");
    const native = join(temporary, "native");
    await mkdir(workspace);
    await mkdir(native);
    const previous = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = native;
    // Controlled ACP peers are used only for protocol-specific scenarios.
    const executable = join(temporary, "agent.mjs");
    await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(acpUrl)});\n`, { mode: 0o700 });
    const agentId =
        label === "Claude Code" ? "claude" : label === "Codex" ? "codex" : label === "Pi" ? "pi" : "opencode";
    const agent = new LocalAgentDefinition(agentId, label, executable, [
        "--agent-name",
        label,
        ...(agentId === "opencode" ? ["--opencode-native-id"] : []),
        ...(profile === "load-only" ? ["--load-only"] : []),
        ...(profile === "replay-history-once" ? ["--load-only", "--replay-history-once"] : []),
        ...(profile === "unsupported"
            ? ["--no-native-sessions"]
            : profile === "invalid-fork"
              ? ["--reuse-session-on-fork"]
              : profile === "exclusive-writer"
                ? ["--exclusive-writer"]
                : profile === "persist-after-first-prompt"
                  ? ["--persist-after-first-prompt"]
                  : []),
    ]);
    const store = new MemoryAcpSessionStore();
    const observer = new NativeSessionObserver();
    let sessions = new AgentRuntimeManager(
        observer,
        store,
        HarnessAdapterRegistry.inMemory(nativeHistoryReader),
        sessionIdentity,
    );
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
    let service = new NativeSessionService(config, directories, sessions, audit, async () => ({
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
    const seed = async (
        title: string,
        additionalDirectories: readonly string[] = [],
        cwd = workspace,
    ): Promise<string> => {
        const external = new AgentRuntimeManager();
        const sessionId = crypto.randomUUID();
        const before = new Set(await readdir(native));
        try {
            await external.runPrompt({
                agent,
                additionalDirectories,
                cwd,
                signal: new AbortController().signal,
                sessionId,
                commandId: crypto.randomUUID(),
                prompt: title,
                images: [],
                resources: [],
                onText: async () => {},
                onActivity: async () => {},
            });
        } finally {
            await external.close();
        }
        const created = (await readdir(native)).find((file) => file.endsWith(".json") && !before.has(file));
        if (created === undefined) {
            throw new Error("The fake Agent did not persist its native session");
        }
        return decodeURIComponent(created.slice(0, -5));
    };
    const list = async (cursor: string | null = null) => {
        const result = await service.execute({ ...identity, action: "list", cursor }, new AbortController().signal);
        if (result.action !== "list") {
            throw new Error("Expected a native session list");
        }
        return result;
    };
    const close = async (): Promise<void> => {
        await sessions.close();
        audit.close();
        if (previous === undefined) {
            delete process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
        } else {
            process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = previous;
        }
        await rm(temporary, { recursive: true, force: true });
    };
    return {
        agent,
        audit,
        config,
        observer,
        directories,
        identity,
        list,
        native,
        seed,
        get service() {
            return service;
        },
        get sessions() {
            return sessions;
        },
        restart: async () => {
            await sessions.close();
            sessions = new AgentRuntimeManager(
                observer,
                store,
                HarnessAdapterRegistry.inMemory(nativeHistoryReader),
                sessionIdentity,
            );
            service = new NativeSessionService(config, directories, sessions, audit, async () => ({
                turn: null,
                queued: [],
            }));
        },
        temporary,
        workspace,
        close,
    };
}
