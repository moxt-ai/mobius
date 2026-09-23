import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
    NativeSessionCommand,
    NativeSessionEntry,
    NativeSessionHistory,
    NativeSessionResult,
    NativeSessionTurnForkCommand,
    SessionReadyEvent,
    WorkspaceEntry,
} from "@moxt-ai/mobius-protocol";
import type { NativeSessionInfo } from "../acp/native-session.ts";
import { nativeSessionIdSchema } from "../acp/native-session.ts";
import { AcpExecutionError, type AcpPrepareOptions, type AcpSessionManager } from "../acp/session-manager.ts";
import type { AuditStore } from "../audit/audit-store.ts";
import { LocalAuthorizationError } from "../authorization/local-authorization-error.ts";
import type { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";
import type { DaemonConfig } from "../config.ts";
import { supportsNativeChat } from "./chat-agent.ts";
import { readClaudeHistory } from "./claude-history.ts";
import { readCodexFullHistory, readCodexHistory } from "./codex-history.ts";
import { readCodexLinkedHistory } from "./codex-linked-history.ts";

interface ListedTarget {
    readonly scope: string;
    readonly nativeSessionId: string;
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
}
interface ListedCursor {
    readonly scope: string;
    readonly cursor: string;
}
interface AuthorizedNativeSession {
    readonly info: NativeSessionInfo;
    readonly cwd: string;
    readonly directoryId: string;
    readonly directoryLabel: string;
    readonly additionalDirectories: readonly string[];
    readonly additionalEntries: readonly WorkspaceEntry[];
}

export class NativeSessionService {
    readonly #entries = new Map<string, ListedTarget>();
    readonly #cursors = new Map<string, ListedCursor>();
    readonly #config: DaemonConfig;
    readonly #directories: WorkspaceDirectoryService;
    readonly #sessions: AcpSessionManager;
    readonly #audit: AuditStore;

    constructor(
        config: DaemonConfig,
        directories: WorkspaceDirectoryService,
        sessions: AcpSessionManager,
        audit: AuditStore,
    ) {
        this.#config = config;
        this.#directories = directories;
        this.#sessions = sessions;
        this.#audit = audit;
    }

    readonly execute = async (command: NativeSessionCommand, signal: AbortSignal): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        const cwd = await this.#directories.resolve(this.#config.bindingId, command.directoryId, signal);
        const additionalDirectories = await this.#directories.resolveMany(
            this.#config.bindingId,
            command.additionalDirectoryIds,
            signal,
        );
        signal.throwIfAborted();
        const options: AcpPrepareOptions = {
            additionalDirectories,
            agent: this.#config.catalog.find(command.agentId),
            cwd,
            sessionId: command.sessionId,
            signal,
        };
        if (command.action === "linked-history") {
            const nativeSessionId = nativeSessionIdSchema.parse(command.targetSessionId);
            if (
                this.#sessions.hasPreparedSession(nativeSessionId, options.agent.id, cwd, additionalDirectories) &&
                (await this.#sessions.loadLinkedSessionHistory({ ...options, sessionId: nativeSessionId })) === null
            ) {
                this.record(command, "native_session_history_read");
                return {
                    action: "linked-history",
                    history: {
                        status: "available",
                        messages: [],
                        truncated: false,
                        coveredCommandIds: [],
                        coveredMessageIds: [],
                    },
                    kind: "native.session.result",
                    requestId: command.requestId,
                    sessionId: command.sessionId,
                    targetSessionId: command.targetSessionId,
                };
            }
            if (options.agent.id === "claude") {
                const history = await readClaudeHistory(
                    this.#sessions,
                    this.#directories,
                    command.bindingId,
                    options,
                    nativeSessionId,
                );
                this.record(command, "native_session_history_read");
                return {
                    action: "linked-history",
                    history,
                    kind: "native.session.result",
                    requestId: command.requestId,
                    sessionId: command.sessionId,
                    targetSessionId: command.targetSessionId,
                };
            }
            if (options.agent.id !== "codex") {
                throw new AcpExecutionError(
                    "This Agent does not support Chat history",
                    {},
                    "native_session_unsupported",
                );
            }
            const history = await readCodexLinkedHistory(
                this.#directories,
                command.bindingId,
                options,
                nativeSessionId,
            );
            this.record(command, "native_session_history_read");
            return {
                action: "linked-history",
                history,
                kind: "native.session.result",
                requestId: command.requestId,
                sessionId: command.sessionId,
                targetSessionId: command.targetSessionId,
            };
        }
        if (command.action === "create") {
            if (!supportsNativeChat(options.agent.id)) {
                throw new AcpExecutionError(
                    "Native session creation is unavailable for this Agent",
                    {},
                    "native_session_unsupported",
                );
            }
            const nativeSessionId = await this.#sessions.createNativeSession(options);
            signal.throwIfAborted();
            this.record(command, "native_session_created");
            return {
                action: "create",
                kind: "native.session.result",
                nativeSessionId,
                requestId: command.requestId,
                sessionId: command.sessionId,
            };
        }
        const prepared = await this.#sessions.prepareNativeSessionBrowser(options);
        if (!prepared.capabilities.listSessions) {
            throw new AcpExecutionError(
                "This Agent does not support native session listing",
                {},
                "native_session_unsupported",
            );
        }
        const entryScope = JSON.stringify([command.agentId, command.bindingId, command.sessionId]);
        const cursorScope = JSON.stringify([entryScope, cwd]);
        const register = async (info: NativeSessionInfo): Promise<NativeSessionEntry | null> => {
            const authorized = await this.authorizeEntry(command, options, info);
            if (authorized === null) {
                return null;
            }
            const entryId = randomUUID();
            if (this.#entries.size >= 5_000) {
                this.#entries.clear();
            }
            this.#entries.set(entryId, {
                scope: entryScope,
                nativeSessionId: info.sessionId,
                cwd: authorized.cwd,
                additionalDirectories: authorized.additionalDirectories,
            });
            return {
                entryId,
                nativeSessionId: info.sessionId,
                title: info.title ?? "Untitled session",
                directoryId: authorized.directoryId,
                directoryLabel: authorized.directoryLabel,
                updatedAt: info.updatedAt ?? null,
                additionalDirectories: authorized.additionalEntries,
            };
        };
        const envelope = {
            kind: "native.session.result",
            requestId: command.requestId,
            sessionId: command.sessionId,
        } satisfies Pick<NativeSessionResult, "kind" | "requestId" | "sessionId">;
        if (command.action === "list") {
            let cursor: string | null = null;
            if (command.cursor !== null) {
                const known = this.#cursors.get(command.cursor);
                if (known?.scope !== cursorScope) {
                    throw new AcpExecutionError(
                        "Refresh the native session list before continuing",
                        {},
                        "native_session_cursor_expired",
                    );
                }
                cursor = known.cursor;
            }
            const page = await this.#sessions.listNativeSessions(options, cursor);
            const entries: NativeSessionEntry[] = [];
            for (const info of page.sessions) {
                const entry = await register(info);
                if (entry !== null) {
                    entries.push(entry);
                }
            }
            let nextCursor: string | null = null;
            if (page.nextCursor != null) {
                if (page.nextCursor === cursor) {
                    throw new AcpExecutionError(
                        "The Agent returned a repeated session cursor",
                        {},
                        "invalid_native_session_response",
                    );
                }
                nextCursor = randomUUID();
                if (this.#cursors.size >= 500) {
                    this.#cursors.clear();
                }
                this.#cursors.set(nextCursor, {
                    scope: cursorScope,
                    cursor: page.nextCursor,
                });
            }
            this.record(command, "native_sessions_listed");
            return {
                ...envelope,
                action: "list",
                capabilities: prepared.capabilities,
                entries,
                nextCursor,
            };
        }
        if (command.action === "find") {
            let cursor: string | null = null;
            let inspected = 0;
            for (let pageNumber = 0; pageNumber < 500; pageNumber += 1) {
                const page = await this.#sessions.listNativeSessions(options, cursor);
                inspected += page.sessions.length;
                const found = page.sessions.find((session) => session.sessionId === command.nativeSessionId);
                if (found !== undefined) {
                    const entry = await register(found);
                    if (entry !== null) {
                        this.record(command, "native_session_found");
                        return { ...envelope, action: "find", entry };
                    }
                    break;
                }
                if (page.nextCursor == null || inspected >= 500) {
                    break;
                }
                if (page.nextCursor === cursor) {
                    throw new AcpExecutionError(
                        "The Agent returned a repeated session cursor",
                        {},
                        "invalid_native_session_response",
                    );
                }
                cursor = page.nextCursor;
            }
            throw new AcpExecutionError("The native session was not found", {}, "native_session_not_found");
        }
        const selected = this.#entries.get(command.entryId);
        if (selected?.scope !== entryScope) {
            throw new AcpExecutionError(
                "Select a session from a fresh native session list",
                {},
                "native_session_not_found",
            );
        }
        if (selected.cwd !== cwd) {
            throw new AcpExecutionError(
                "The selected session belongs to a different workspace. Refresh the list before continuing.",
                {},
                "native_session_target_changed",
            );
        }
        const target = await this.resolveTarget(command, options, selected);
        if (command.action === "history") {
            const history = await this.readHistory(command, options, target, signal);
            signal.throwIfAborted();
            this.record(command, "native_session_history_read");
            return {
                ...envelope,
                action: "history",
                entryId: command.entryId,
                history,
                title: target.info.title ?? "Untitled session",
            };
        }
        if (command.action === "preview") {
            const history = await this.previewHistory(command, options, target, signal);
            signal.throwIfAborted();
            this.record(command, "native_session_previewed");
            return {
                ...envelope,
                action: "preview",
                entryId: command.entryId,
                targetSessionId: command.sessionId,
                reason: "requested",
                title: target.info.title ?? "Untitled session",
                history,
            };
        }
        if (command.action === "delete") {
            if (!prepared.capabilities.deleteSession) {
                throw new AcpExecutionError(
                    "This Agent does not support native session deletion",
                    {},
                    "native_session_unsupported",
                );
            }
            signal.throwIfAborted();
            this.record(command, "native_session_delete_authorized");
            const deletedSessionIds = await this.#sessions.deleteNativeSession(options, target.info.sessionId);
            this.record(command, "native_session_deleted");
            return {
                ...envelope,
                action: "delete",
                entryId: command.entryId,
                deletedSessionIds,
            };
        }
        const action =
            command.action === "import-only" ? "import" : command.action === "fork-only" ? "fork" : command.action;
        if (action === "import" && !prepared.capabilities.loadSession && !prepared.capabilities.resumeSession) {
            throw new AcpExecutionError("This Agent cannot import native sessions", {}, "native_session_unsupported");
        }
        if (action === "fork" && !prepared.capabilities.unstableForkSession) {
            throw new AcpExecutionError(
                "This Agent does not support session forking",
                {},
                "native_session_unsupported",
            );
        }
        if (target.additionalDirectories.length > 0 && !prepared.capabilities.additionalDirectories) {
            throw new AcpExecutionError(
                "This Agent cannot restore additional working directories",
                {},
                "native_session_unsupported",
            );
        }
        const opened = await this.#sessions.openNativeSession(
            {
                ...options,
                cwd: target.cwd,
                sessionId: command.targetSessionId,
                additionalDirectories: target.additionalDirectories,
            },
            { kind: action, nativeSessionId: target.info.sessionId },
            command.action !== "import-only" && command.action !== "fork-only",
        );
        signal.throwIfAborted();
        const ready: SessionReadyEvent = {
            additionalDirectories: target.additionalEntries,
            agentId: command.agentId,
            agentName: opened.prepared.agentName,
            agentVersion: opened.prepared.agentVersion,
            capabilities: opened.prepared.capabilities,
            commands: opened.prepared.commands,
            configOptions: opened.prepared.configOptions,
            directoryId: target.directoryId,
            directoryLabel: target.directoryLabel,
            kind: "session.ready",
            requestId: command.requestId,
            restored: true,
            sessionId: opened.sessionId,
        };
        this.record(command, action === "fork" ? "native_session_forked" : "native_session_imported");
        return {
            ...envelope,
            action,
            ready,
            targetSessionId: command.targetSessionId,
            title: target.info.title ?? "Untitled session",
            history: opened.history,
        };
    };

    readonly executeTurnFork = async (
        command: NativeSessionTurnForkCommand,
        signal: AbortSignal,
    ): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        const cwd = await this.#directories.resolve(this.#config.bindingId, command.directoryId, signal);
        const additionalDirectories: string[] = [];
        const additionalEntries: WorkspaceEntry[] = [];
        const resolvedPaths = new Set<string>([cwd]);
        for (const directoryId of command.additionalDirectoryIds) {
            const path = await this.#directories.resolve(this.#config.bindingId, directoryId, signal);
            if (resolvedPaths.has(path)) {
                throw new LocalAuthorizationError("Workspace directories must resolve to distinct locations");
            }
            resolvedPaths.add(path);
            additionalDirectories.push(path);
            additionalEntries.push({ directoryId, name: basename(path) });
        }
        const listing = await this.#directories.list(this.#config.bindingId, command.directoryId, signal);
        const opened = await this.#sessions.forkSessionAtTurn(
            {
                additionalDirectories,
                agent: this.#config.catalog.find(command.agentId),
                cwd,
                sessionId: command.targetSessionId,
                signal,
            },
            command.sessionId,
            {
                messageFingerprint: command.messageFingerprint,
                messageId: command.messageId,
                messageOccurrence: command.messageOccurrence,
            },
        );
        signal.throwIfAborted();
        const ready: SessionReadyEvent = {
            additionalDirectories: additionalEntries,
            agentId: command.agentId,
            agentName: opened.prepared.agentName,
            agentVersion: opened.prepared.agentVersion,
            capabilities: opened.prepared.capabilities,
            commands: opened.prepared.commands,
            configOptions: opened.prepared.configOptions,
            directoryId: command.directoryId,
            directoryLabel: listing.directoryLabel,
            kind: "session.ready",
            requestId: command.requestId,
            restored: true,
            sessionId: opened.sessionId,
        };
        this.#audit.record({
            commandId: command.requestId,
            details: {
                agentId: command.agentId,
                messageId: command.messageId,
                sourceCommandId: command.sourceCommandId,
            },
            event: "native_session_turn_forked",
            sessionId: command.sessionId,
        });
        return {
            action: "fork",
            history: opened.history,
            kind: "native.session.result",
            ready,
            requestId: command.requestId,
            sessionId: command.sessionId,
            targetSessionId: command.targetSessionId,
            title: command.title,
        };
    };

    private readonly previewHistory = async (
        command: NativeSessionCommand,
        options: AcpPrepareOptions,
        target: AuthorizedNativeSession,
        signal: AbortSignal,
    ): Promise<NativeSessionHistory> => {
        if (options.agent.id !== "codex") {
            return await this.#sessions.previewNativeSession(
                { ...options, cwd: target.cwd, additionalDirectories: target.additionalDirectories },
                target.info.sessionId,
            );
        }
        // Codex enforces an exclusive writer per thread. Reading through raw
        // thread/read + thread/turns/list, instead of ACP session/load, avoids
        // acquiring that lock so an externally owned thread stays previewable.
        const snapshot = await readCodexHistory(options.agent, target.cwd, target.info.sessionId, signal);
        const resolved = await this.#directories.identify(command.bindingId, snapshot.cwd, signal);
        if (snapshot.nativeSessionId !== target.info.sessionId || resolved.path !== target.cwd) {
            throw new AcpExecutionError(
                "Codex returned history for a different session or workspace.",
                {},
                "invalid_native_session_response",
            );
        }
        return snapshot.history;
    };

    private readonly readHistory = async (
        command: NativeSessionCommand,
        options: AcpPrepareOptions,
        target: AuthorizedNativeSession,
        signal: AbortSignal,
    ): Promise<NativeSessionHistory> => {
        if (options.agent.id !== "codex") {
            throw new AcpExecutionError(
                "Native history is unavailable for this Agent",
                {},
                "native_session_unsupported",
            );
        }
        const snapshot = await readCodexFullHistory(options.agent, target.cwd, target.info.sessionId, signal);
        const resolved = await this.#directories.identify(command.bindingId, snapshot.cwd, signal);
        if (snapshot.nativeSessionId !== target.info.sessionId || resolved.path !== target.cwd) {
            throw new AcpExecutionError(
                "Codex returned history for a different session or workspace.",
                {},
                "invalid_native_session_response",
            );
        }
        return snapshot.history;
    };

    private readonly authorizeEntry = async (
        command: NativeSessionCommand,
        options: AcpPrepareOptions,
        info: NativeSessionInfo,
    ): Promise<AuthorizedNativeSession | null> => {
        try {
            const primary = await this.#directories.identify(command.bindingId, info.cwd, options.signal);
            const additionalDirectories: string[] = [];
            const additionalEntries: WorkspaceEntry[] = [];
            const paths = new Set([primary.path]);
            for (const path of info.additionalDirectories) {
                const directory = await this.#directories.identify(command.bindingId, path, options.signal);
                if (paths.has(directory.path)) {
                    throw new LocalAuthorizationError("Native session roots must be distinct");
                }
                paths.add(directory.path);
                additionalDirectories.push(directory.path);
                additionalEntries.push({
                    directoryId: directory.directoryId,
                    name: directory.name,
                });
            }
            return {
                info,
                cwd: primary.path,
                directoryId: primary.directoryId,
                directoryLabel: primary.label,
                additionalDirectories,
                additionalEntries,
            };
        } catch (error) {
            options.signal.throwIfAborted();
            if (error instanceof LocalAuthorizationError) {
                return null;
            }
            throw error;
        }
    };

    private readonly resolveTarget = async (
        command: NativeSessionCommand,
        options: AcpPrepareOptions,
        selected: ListedTarget,
    ): Promise<AuthorizedNativeSession> => {
        let cursor: string | null = null;
        const visited = new Set<string>();
        for (let index = 0; index < 100; index += 1) {
            const page = await this.#sessions.listNativeSessions(options, cursor);
            const info = page.sessions.find((entry) => entry.sessionId === selected.nativeSessionId);
            if (info !== undefined) {
                const target = await this.authorizeEntry(command, options, info);
                if (target === null) {
                    throw new LocalAuthorizationError("The selected native session is not authorized");
                }
                if (
                    target.cwd !== selected.cwd ||
                    target.additionalDirectories.length !== selected.additionalDirectories.length ||
                    target.additionalDirectories.some((path, index) => path !== selected.additionalDirectories[index])
                ) {
                    throw new AcpExecutionError(
                        "This session's directory changed. Refresh the list before continuing.",
                        {},
                        "native_session_target_changed",
                    );
                }
                return target;
            }
            cursor = page.nextCursor ?? null;
            if (cursor === null) {
                break;
            }
            if (visited.has(cursor)) {
                throw new AcpExecutionError(
                    "The Agent returned a repeated session cursor",
                    {},
                    "invalid_native_session_response",
                );
            }
            visited.add(cursor);
        }
        throw new AcpExecutionError(
            "The selected native session no longer exists. Refresh the list.",
            {},
            "native_session_not_found",
        );
    };

    private readonly record = (command: NativeSessionCommand, event: string): void => {
        this.#audit.record({
            commandId: command.requestId,
            sessionId: command.sessionId,
            event,
            details: { agentId: command.agentId },
        });
    };
}
