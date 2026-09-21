import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeSessionCommand, NativeSessionEntry } from "@moxt-ai/mobius-protocol";
import { describe, expect, it, vi } from "vitest";
import { AcpSessionManager, NullAcpSessionObserver } from "../../../packages/cli/src/acp/session-manager.ts";
import { SqliteAcpSessionStore } from "../../../packages/cli/src/acp/session-store.ts";
import { AuditStore } from "../../../packages/cli/src/audit/audit-store.ts";
import { WorkspaceDirectoryService } from "../../../packages/cli/src/authorization/workspace-directory.ts";
import { createDaemonConfig, LocalAgentDefinition } from "../../../packages/cli/src/config.ts";
import { NativeSessionService } from "../../../packages/cli/src/native-sessions/service.ts";

const acpUrl = new URL("../fixtures/fake-acp-agent/src/cli.ts", import.meta.url).toString();
const appServerUrl = new URL("../fixtures/fake-acp-agent/src/app-server.ts", import.meta.url).toString();

// Real providers cannot deterministically supply destructive test sessions or stalled
// loads. These ACP subprocesses maintain their own disposable session files.
class NativeSessionObserver extends NullAcpSessionObserver {
    readonly loading = Promise.withResolvers<void>();
    override readonly onInfo = async (): Promise<void> => {
        this.loading.resolve();
    };
}

async function fixture(
    label: string,
    profile: "supported" | "unsupported" | "invalid-fork" | "exclusive-writer" = "supported",
) {
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "mobius-native-boundary-")));
    const workspace = join(temporary, "workspace");
    const native = join(temporary, "native");
    await mkdir(workspace);
    await mkdir(native);
    const previous = process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"];
    process.env["MOBIUS_FAKE_ACP_STATE_DIRECTORY"] = native;
    // Codex's saved-history preview spawns `codex app-server` separately from
    // the ACP Agent process; dispatch to either fixture entrypoint by argv,
    // mirroring the real Codex CLI's two entrypoints under one executable.
    const executable = join(temporary, "agent.mjs");
    await writeFile(
        executable,
        `#!${process.execPath}\nawait import(process.argv.includes("app-server") ? ${JSON.stringify(appServerUrl)} : ${JSON.stringify(acpUrl)});\n`,
        { mode: 0o700 },
    );
    const agent = new LocalAgentDefinition(label === "Codex" ? "codex" : "claude", label, executable, [
        "--agent-name",
        label,
        ...(profile === "unsupported"
            ? ["--no-native-sessions"]
            : profile === "invalid-fork"
              ? ["--reuse-session-on-fork"]
              : profile === "exclusive-writer"
                ? ["--exclusive-writer"]
                : []),
    ]);
    const storePath = join(temporary, "sessions.sqlite");
    const store = new SqliteAcpSessionStore(storePath);
    const observer = new NativeSessionObserver();
    const sessions = new AcpSessionManager(observer, store);
    const audit = new AuditStore(join(temporary, "audit.sqlite"));
    const config = createDaemonConfig(
        {
            defaultWorkspace: workspace,
            auditDatabasePath: join(temporary, "audit.sqlite"),
            channelId: "test-channel",
            relayUrl: new URL("ws://localhost/"),
        },
        [agent],
    );
    const directories = new WorkspaceDirectoryService("workspace", workspace);
    const service = new NativeSessionService(config, directories, sessions, audit);
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
        const external = new AcpSessionManager();
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
        store.close();
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
        observer,
        directories,
        identity,
        list,
        native,
        seed,
        service,
        sessions,
        storePath,
        temporary,
        workspace,
        close,
    };
}

describe("native Agent session boundary", () => {
    it("Given a saved local conversation, When its history is previewed and then forked, Then preview leaves the source untouched and only the fork creates a new conversation", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
        const f = await fixture("Codex", "exclusive-writer");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const files = await readdir(f.native);
            const source = files.find((file) => file.endsWith(".json"));
            if (source === undefined) {
                throw new Error("Missing saved native conversation");
            }
            const original = await readFile(join(f.native, source), "utf8");
            const preview = await f.service.execute(
                { ...f.identity, action: "preview", entryId: entry.entryId },
                new AbortController().signal,
            );
            expect(preview).toMatchObject({
                action: "preview",
                reason: "requested",
                history: {
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Original context" }]),
                },
            });
            expect(await readdir(f.native)).toEqual(files);
            expect(await readFile(join(f.native, source), "utf8")).toBe(original);
            const fork = await f.service.execute(
                {
                    ...f.identity,
                    action: "fork",
                    entryId: entry.entryId,
                    targetSessionId: "forked-copy",
                },
                new AbortController().signal,
            );
            expect(fork).toMatchObject({
                action: "fork",
                ready: { sessionId: "forked-copy" },
                history: {
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Original context" }]),
                },
            });
            expect((await f.list()).entries).toHaveLength(2);
            expect(await readFile(join(f.native, source), "utf8")).toBe(original);
        } finally {
            await f.close();
            vi.useRealTimers();
        }
    });
    it.each(["import", "fork"] satisfies readonly ("import" | "fork")[])(
        "Given cloud retention is disabled, When a saved conversation is %sed, Then the conversation opens without loading or returning native history",
        async (action) => {
            const f = await fixture("Claude Code");
            try {
                await f.seed("Private native history");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                await writeFile(join(f.native, "pause-load"), "");

                const result = await f.service.execute(
                    {
                        ...f.identity,
                        action: action === "import" ? "import-only" : "fork-only",
                        entryId: entry.entryId,
                        targetSessionId: `${action}-without-history`,
                    },
                    new AbortController().signal,
                );

                expect(result).toMatchObject({
                    action,
                    history: { status: "unavailable" },
                    ready: { sessionId: `${action}-without-history` },
                });
                if (result.action !== action) {
                    throw new Error(`Expected ${action} result`);
                }
                expect(await readdir(f.native)).not.toContain("load-paused");
            } finally {
                await f.close();
            }
        },
    );
    it("Given a Codex conversation is open in another writer, When its history is previewed, Then the preview succeeds without acquiring Codex's exclusive writer lock", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
        const f = await fixture("Codex", "exclusive-writer");
        const external = new AcpSessionManager();
        try {
            await external.runPrompt({
                agent: f.agent,
                additionalDirectories: [],
                cwd: f.workspace,
                signal: new AbortController().signal,
                sessionId: "external",
                commandId: "external-turn",
                prompt: "Externally owned conversation",
                images: [],
                resources: [],
                onText: async () => {},
                onActivity: async () => {},
            });
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            // The external writer stays open for the entire preview; a lock-acquiring
            // read (ACP session/load) would fail here with "already has an active writer".
            const preview = await f.service.execute(
                { ...f.identity, action: "preview", entryId: entry.entryId },
                new AbortController().signal,
            );
            expect(preview).toMatchObject({
                action: "preview",
                reason: "requested",
                history: {
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Externally owned conversation" }]),
                },
            });
            await expect(
                external.runPrompt({
                    agent: f.agent,
                    additionalDirectories: [],
                    cwd: f.workspace,
                    signal: new AbortController().signal,
                    sessionId: "external",
                    commandId: "external-turn-after-preview",
                    prompt: "Still owned by the external writer",
                    images: [],
                    resources: [],
                    onText: async () => {},
                    onActivity: async () => {},
                }),
            ).resolves.toMatchObject({ stopReason: "end_turn" });
        } finally {
            await external.close();
            await f.close();
            vi.useRealTimers();
        }
    });
    it("Given a saved Codex conversation is open elsewhere, When a user imports it and retries after it closes, Then the original opening error is reported and the retry opens the conversation", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
        const f = await fixture("Codex", "exclusive-writer");
        const external = new AcpSessionManager();
        try {
            await external.runPrompt({
                agent: f.agent,
                additionalDirectories: [],
                cwd: f.workspace,
                signal: new AbortController().signal,
                sessionId: "external",
                commandId: "external-turn",
                prompt: "Saved conversation",
                images: [],
                resources: [],
                onText: async () => {},
                onActivity: async () => {},
            });
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            const command = {
                ...f.identity,
                action: "import",
                entryId: entry.entryId,
                targetSessionId: "imported",
            } satisfies NativeSessionCommand;
            await expect(f.service.execute(command, new AbortController().signal)).rejects.toMatchObject({
                code: "acp_agent_error",
            });
            await external.close();
            expect(await f.service.execute(command, new AbortController().signal)).toMatchObject({
                action: "import",
                ready: { sessionId: "imported" },
                history: {
                    status: "available",
                    messages: expect.arrayContaining([{ role: "user", text: "Saved conversation" }]),
                },
            });
        } finally {
            await external.close();
            await f.close();
            vi.useRealTimers();
        }
    });
    it("Given an Agent returns the original session as a fork, When a user requests an independent conversation, Then the invalid fork is rejected", async () => {
        const f = await fixture("Codex", "invalid-fork");
        try {
            await f.seed("Original context");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            await expect(
                f.service.execute(
                    {
                        ...f.identity,
                        action: "fork",
                        entryId: entry.entryId,
                        targetSessionId: "invalid-fork",
                    },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: "invalid_native_session_response" });
            expect((await f.list()).entries.map((session) => session.title)).toEqual(["Original context"]);
        } finally {
            await f.close();
        }
    });
    it.each(["Codex", "Claude Code"])(
        "Given %s has saved conversations across projects, When they are listed and imported, Then pagination includes other directories and imports retain their original project and Mobius identity",
        async (label) => {
            const f = await fixture(label);
            try {
                const outside = join(f.temporary, "outside");
                await mkdir(outside);
                await f.seed("Saved one");
                await f.seed("Saved two");
                await f.seed("Saved three");
                await f.seed("Additional project", [outside]);
                await f.seed("Other project", [], outside);
                const entries: NativeSessionEntry[] = [];
                let cursor: string | null = null;
                do {
                    const page = await f.list(cursor);
                    entries.push(...page.entries);
                    cursor = page.nextCursor;
                } while (cursor !== null);
                expect(entries.map((entry) => entry.title).sort()).toEqual([
                    "Additional project",
                    "Other project",
                    "Saved one",
                    "Saved three",
                    "Saved two",
                ]);
                const entry = entries.find((entry) => entry.title === "Other project");
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                const command = {
                    ...f.identity,
                    action: "import",
                    directoryId: entry.directoryId,
                    entryId: entry.entryId,
                    targetSessionId: "imported",
                } satisfies NativeSessionCommand;
                const first = await f.service.execute(command, new AbortController().signal);
                expect(first).toMatchObject({
                    action: "import",
                    ready: {
                        sessionId: "imported",
                        restored: true,
                        directoryId: entry.directoryId,
                        directoryLabel: entry.directoryLabel,
                        capabilities: {
                            listSessions: true,
                            deleteSession: true,
                            unstableForkSession: true,
                        },
                    },
                });
                expect(
                    await f.service.execute({ ...command, targetSessionId: "duplicate" }, new AbortController().signal),
                ).toMatchObject({ ready: { sessionId: "imported" } });
                await expect(
                    f.service.execute({ ...command, entryId: "forged" }, new AbortController().signal),
                ).rejects.toMatchObject({ code: "native_session_not_found" });
                await expect(f.list("forged-cursor")).rejects.toMatchObject({
                    code: "native_session_cursor_expired",
                });
            } finally {
                await f.close();
            }
        },
    );

    it("Given paginated native sessions, When one is found by its native ID, Then only an opaque authorized entry is returned and can be imported", async () => {
        const f = await fixture("Codex");
        try {
            await f.seed("Earlier conversation");
            await f.seed("Another conversation");
            const nativeSessionId = await f.seed("Current handoff conversation");
            const found = await f.service.execute(
                { ...f.identity, action: "find", nativeSessionId },
                new AbortController().signal,
            );
            expect(found).toMatchObject({
                action: "find",
                entry: { title: "Current handoff conversation" },
            });
            expect(JSON.stringify(found)).not.toContain(nativeSessionId);
            if (found.action !== "find") {
                throw new Error("Expected an opaque native session lookup");
            }
            await expect(
                f.service.execute(
                    {
                        ...f.identity,
                        action: "import",
                        entryId: found.entry.entryId,
                        targetSessionId: "handoff-import",
                    },
                    new AbortController().signal,
                ),
            ).resolves.toMatchObject({
                action: "import",
                ready: { sessionId: "handoff-import" },
                history: {
                    messages: expect.arrayContaining([{ role: "user", text: "Current handoff conversation" }]),
                },
            });
        } finally {
            await f.close();
        }
    });

    it("Given a listed session uses a linked directory, When that directory changes before deletion, Then the local boundary requires a refreshed selection before deleting the session", async () => {
        const f = await fixture("Codex");
        try {
            const inside = join(f.workspace, "inside");
            const outside = join(f.temporary, "outside");
            const alias = join(f.workspace, "alias");
            await mkdir(inside);
            await mkdir(outside);
            await symlink(inside, alias);
            await f.seed("Moving roots", [alias]);
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            await rm(alias);
            await symlink(outside, alias);
            await expect(
                f.service.execute(
                    { ...f.identity, action: "delete", entryId: entry.entryId },
                    new AbortController().signal,
                ),
            ).rejects.toMatchObject({ code: "native_session_target_changed" });
            expect((await readdir(f.native)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
            expect((await f.list()).entries).toEqual([expect.objectContaining({ title: "Moving roots" })]);
        } finally {
            await f.close();
        }
    });

    it.each(["import", "fork"] satisfies readonly ("import" | "fork")[])(
        "Given an Agent stalls while loading %s history, When a prompt arrives and the deadline expires, Then the prompt is rejected and cancellation preserves the saved session",
        async (action) => {
            vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
            vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
            const f = await fixture("Codex");
            try {
                await f.seed("Keep on timeout");
                const entry = (await f.list()).entries[0];
                if (entry === undefined) {
                    throw new Error("Missing native conversation");
                }
                await writeFile(join(f.native, "pause-load"), "");
                const controller = new AbortController();
                const reason = new Error("Deadline elapsed");
                const loading = f.service.execute(
                    {
                        ...f.identity,
                        action,
                        entryId: entry.entryId,
                        targetSessionId: "loading-chat",
                    },
                    controller.signal,
                );
                const cancelled = expect(loading).rejects.toBe(reason);
                await f.observer.loading.promise;
                const attempted = await Promise.allSettled([
                    f.sessions.runPrompt({
                        agent: f.agent,
                        additionalDirectories: [],
                        cwd: f.workspace,
                        sessionId: "loading-chat",
                        commandId: "concurrent-prompt",
                        prompt: "Wait for history",
                        images: [],
                        resources: [],
                        onText: async () => {},
                        onActivity: async () => {},
                        signal: new AbortController().signal,
                    }),
                ]);
                const timeout = setTimeout(() => controller.abort(reason), 90_000);
                await vi.advanceTimersByTimeAsync(90_000);
                clearTimeout(timeout);
                await cancelled;
                expect(attempted).toMatchObject([{ status: "rejected", reason: { code: "session_busy" } }]);
                expect((await f.list()).entries.map((session) => session.title)).toEqual([
                    "Keep on timeout",
                    ...(action === "fork" ? ["Keep on timeout"] : []),
                ]);
            } finally {
                await f.close();
                vi.useRealTimers();
            }
        },
    );

    it("Given an Agent omits native session capabilities, When a remote caller requests its sessions, Then the local boundary rejects the operation", async () => {
        const f = await fixture("Codex", "unsupported");
        try {
            const ready = await f.sessions.prepareSession({
                agent: f.agent,
                cwd: f.workspace,
                additionalDirectories: [],
                sessionId: "browser",
                signal: new AbortController().signal,
            });
            expect(ready.capabilities).toMatchObject({
                listSessions: false,
                deleteSession: false,
                unstableForkSession: false,
            });
            await expect(f.list()).rejects.toMatchObject({
                code: "native_session_unsupported",
            });
        } finally {
            await f.close();
        }
    });

    it("Given a paired machine without a terminal confirmation, When the current native session is deleted and the daemon restarts, Then deletion succeeds and the former conversation cannot create a replacement", async () => {
        const f = await fixture("Codex");
        try {
            await f.seed("Delete persistently");
            const entry = (await f.list()).entries[0];
            if (entry === undefined) {
                throw new Error("Missing native conversation");
            }
            await f.service.execute(
                {
                    ...f.identity,
                    action: "import",
                    entryId: entry.entryId,
                    targetSessionId: "deleted-chat",
                },
                new AbortController().signal,
            );
            const currentIdentity = { ...f.identity, sessionId: "deleted-chat" };
            const currentList = await f.service.execute(
                { ...currentIdentity, action: "list", cursor: null },
                new AbortController().signal,
            );
            if (currentList.action !== "list" || currentList.entries[0] === undefined) {
                throw new Error("Missing current conversation");
            }
            expect(
                await f.service.execute(
                    {
                        ...currentIdentity,
                        action: "delete",
                        entryId: currentList.entries[0].entryId,
                    },
                    new AbortController().signal,
                ),
            ).toMatchObject({ deletedSessionIds: ["deleted-chat"] });
            expect((await readdir(f.native)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
            await f.sessions.close();
            const reopenedStore = new SqliteAcpSessionStore(f.storePath);
            const restarted = new AcpSessionManager(undefined, reopenedStore);
            try {
                await expect(
                    restarted.prepareSession({
                        agent: f.agent,
                        additionalDirectories: [],
                        cwd: f.workspace,
                        sessionId: "deleted-chat",
                        signal: new AbortController().signal,
                    }),
                ).rejects.toMatchObject({ code: "native_session_deleted" });
            } finally {
                await restarted.close();
                reopenedStore.close();
            }
            expect((await f.list()).entries).toEqual([]);
        } finally {
            await f.close();
        }
    });
});
