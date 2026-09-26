import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

export async function codexFixture(sessionIdentity: "assigned" | "native" = "assigned") {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "mobius-native-codex-")));
    const workspace = join(temporary, "workspace");
    const native = join(temporary, "native");
    await mkdir(workspace);
    await mkdir(native);
    const previous = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = native;
    const appServerUrl = new URL("../fixtures/fake-acp-agent/src/app-server.ts", import.meta.url).toString();
    const executable = join(temporary, "codex.mjs");
    await writeFile(executable, `#!${process.execPath}\nawait import(${JSON.stringify(appServerUrl)});\n`, {
        mode: 0o700,
    });
    const agent = new InProcessAcpAgentDefinition(
        "codex",
        "Codex",
        executable,
        (options) => new CodexAcpAgent(options),
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
    const seed = async (title: string): Promise<void> => {
        await writeFile(
            join(native, `${encodeURIComponent(crypto.randomUUID())}.json`),
            JSON.stringify({ cwd: workspace, title, history: [{ role: "user", text: title }] }),
        );
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
    return { identity, list, native, seed, service, workspace, close };
}
