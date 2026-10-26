import { randomUUID } from "node:crypto";
import {
    decodeIdentifier,
    type Identifier,
    type NativeSessionCommand,
    type NativeSessionEntry,
    type NativeSessionResult,
    type SessionMetadata,
    type SessionReadyEvent,
    type WorkspaceEntry,
} from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { NativeSessionInfo } from "../../acp/protocol/native-session.ts";
import { nativeSessionIdSchema } from "../../acp/protocol/native-session.ts";
import type { ResolveAgent, SessionPrepareOptions } from "../api/session-api.ts";
import { RuntimeOperations } from "../manager/operation-drain.ts";
import type { SessionManager } from "../manager/session-manager.ts";
import type { StoredSession } from "../record/session-store.ts";
import { LocalAuthorizationError } from "../workspace/local-authorization-error.ts";
import type { WorkspaceDirectoryService } from "../workspace/workspace-directory.ts";

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

const MAXIMUM_SESSION_TITLE_LENGTH = 500;
const forkSuffixPattern = / \(Fork #([1-9][0-9]*)\)$/u;

function nextForkTitle(sourceTitle: string, sessions: readonly StoredSession[]): string {
    let highest = 0;
    for (const session of sessions) {
        const match = forkSuffixPattern.exec(session.title);
        const encodedNumber = match?.[1];
        if (encodedNumber === undefined) {
            continue;
        }
        const number = Number(encodedNumber);
        if (!Number.isSafeInteger(number)) {
            continue;
        }
        const suffix = ` (Fork #${number})`;
        if (`${sourceTitle.slice(0, MAXIMUM_SESSION_TITLE_LENGTH - suffix.length)}${suffix}` === session.title) {
            highest = Math.max(highest, number);
        }
    }
    const number = highest + 1;
    const suffix = ` (Fork #${number})`;
    return `${sourceTitle.slice(0, MAXIMUM_SESSION_TITLE_LENGTH - suffix.length)}${suffix}`;
}

export class NativeSessionService {
    readonly #operations = new RuntimeOperations();
    readonly #entries = new Map<string, ListedTarget>();
    readonly #cursors = new Map<string, ListedCursor>();
    readonly #bindingId: string;
    readonly #resolveAgent: ResolveAgent;
    readonly #directories: WorkspaceDirectoryService;
    readonly #sessions: SessionManager;
    readonly #activeTurn: (
        command: Extract<NativeSessionCommand, { readonly action: "active-turn" }>,
        options: SessionPrepareOptions,
    ) => Promise<Pick<Extract<NativeSessionResult, { readonly action: "active-turn" }>, "turn" | "queued">>;

    constructor(
        bindingId: string,
        resolveAgent: ResolveAgent,
        directories: WorkspaceDirectoryService,
        sessions: SessionManager,
        activeTurn: (
            command: Extract<NativeSessionCommand, { readonly action: "active-turn" }>,
            options: SessionPrepareOptions,
        ) => Promise<Pick<Extract<NativeSessionResult, { readonly action: "active-turn" }>, "turn" | "queued">>,
    ) {
        this.#bindingId = bindingId;
        this.#resolveAgent = resolveAgent;
        this.#directories = directories;
        this.#sessions = sessions;
        this.#activeTurn = activeTurn;
    }

    readonly execute = async (command: NativeSessionCommand, signal: AbortSignal): Promise<NativeSessionResult> => {
        return await this.#operations.run({ signal }, (scoped) => this.#execute(command, scoped.signal));
    };

    readonly close = (): Promise<void> => this.#operations.close(async () => undefined);

    readonly readSessionHistory = async (
        options: SessionPrepareOptions,
        nativeSessionId: string,
        eventLimit: number,
        cursor: string | null,
    ) =>
        this.#operations.run(options, (scoped) =>
            this.#sessions.withNativeSessionOperation(scoped, nativeSessionId, (target) =>
                target.adapter.readSessionHistory(target, {
                    nativeSessionId,
                    eventLimit,
                    cursor,
                    sessionId: target.sessionId,
                }),
            ),
        );

    readonly #execute = async (command: NativeSessionCommand, signal: AbortSignal): Promise<NativeSessionResult> => {
        signal.throwIfAborted();
        const cwd = await this.#directories.resolve(this.#bindingId, command.directoryId, signal);
        const additionalDirectories = await this.#directories.resolveMany(
            this.#bindingId,
            command.additionalDirectoryIds,
            signal,
        );
        signal.throwIfAborted();
        const options: SessionPrepareOptions = {
            additionalDirectories,
            ...(await this.#resolveAgent(command.agentId, signal)),
            cwd,
            sessionId: command.sessionId,
            signal,
        };
        if (command.action === "active-turn") {
            nativeSessionIdSchema.parse(command.targetSessionId);
            return {
                action: "active-turn",
                kind: "native.session.result",
                requestId: command.requestId,
                sessionId: command.sessionId,
                targetSessionId: command.targetSessionId,
                ...(await this.#activeTurn(command, options)),
            };
        }
        const capabilities = await options.adapter.getCapabilities(options);
        if (!capabilities.listSessions) {
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
            const entryId = decodeIdentifier(randomUUID());
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
                mobiusSessionIds: this.#sessions
                    .findLinkedSessions(command.agentId, info.sessionId)
                    .filter((session) => session.prompted && session.cwd === authorized.cwd)
                    .map((session) => decodeIdentifier(session.sessionId)),
                nativeSessionId: decodeIdentifier(info.sessionId),
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
            const page = await options.adapter.listSessions(options, cursor);
            const entries: NativeSessionEntry[] = [];
            for (const info of page.sessions) {
                const entry = await register(info);
                if (entry !== null) {
                    entries.push(entry);
                }
            }
            let nextCursor: Identifier | null = null;
            if (page.nextCursor != null) {
                if (page.nextCursor === cursor) {
                    throw new AcpExecutionError(
                        "The Agent returned a repeated session cursor",
                        {},
                        "invalid_native_session_response",
                    );
                }
                nextCursor = decodeIdentifier(randomUUID());
                if (this.#cursors.size >= 500) {
                    this.#cursors.clear();
                }
                this.#cursors.set(nextCursor, {
                    scope: cursorScope,
                    cursor: page.nextCursor,
                });
            }
            return {
                ...envelope,
                action: "list",
                capabilities,
                entries,
                nextCursor,
            };
        }
        if (command.action === "find") {
            const found = await options.adapter.findSession(options, command.nativeSessionId, {
                maximumPages: 500,
                maximumEntries: 500,
            });
            const entry = await register(found);
            if (entry !== null) {
                return { ...envelope, action: "find", entry };
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
        const action = command.action;
        if (action === "import" && !capabilities.loadSession && !capabilities.resumeSession) {
            throw new AcpExecutionError("This Agent cannot import native sessions", {}, "native_session_unsupported");
        }
        if (action === "fork" && !capabilities.unstableForkSession) {
            throw new AcpExecutionError(
                "This Agent does not support session forking",
                {},
                "native_session_unsupported",
            );
        }
        if (target.additionalDirectories.length > 0 && !capabilities.additionalDirectories) {
            throw new AcpExecutionError(
                "This Agent cannot restore additional working directories",
                {},
                "native_session_unsupported",
            );
        }
        const sourceTitle = target.info.title ?? "Untitled session";
        const title =
            action === "fork"
                ? nextForkTitle(sourceTitle, this.#sessions.listSessions(Number.MAX_SAFE_INTEGER))
                : sourceTitle;
        const opened = await this.#sessions.openNativeSession(
            {
                ...options,
                cwd: target.cwd,
                sessionId: command.targetSessionId,
                additionalDirectories: target.additionalDirectories,
            },
            action === "fork"
                ? { kind: "fork", nativeSessionId: target.info.sessionId, title }
                : { kind: "import", nativeSessionId: target.info.sessionId, title },
            this.#resolveAgent,
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
        return {
            ...envelope,
            action,
            ready,
            targetSessionId: command.targetSessionId,
            title,
        };
    };

    readonly listSessions = async (limit: number, signal: AbortSignal): Promise<readonly SessionMetadata[]> =>
        await this.describeSessions(this.#sessions.listSessions(limit), signal);

    readonly querySessions = async (
        sessionIds: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly SessionMetadata[]> =>
        await this.describeSessions(this.#sessions.findSessions(sessionIds), signal);

    private readonly describeSessions = async (
        sessions: readonly StoredSession[],
        signal: AbortSignal,
    ): Promise<readonly SessionMetadata[]> => {
        const entries: SessionMetadata[] = [];
        for (const session of sessions) {
            signal.throwIfAborted();
            const directory = await this.#directories.identify(this.#bindingId, session.cwd, signal);
            const additionalDirectories = [];
            for (const path of session.additionalDirectories) {
                const identified = await this.#directories.identify(this.#bindingId, path, signal);
                additionalDirectories.push({ directoryId: identified.directoryId, name: identified.name });
            }
            entries.push({
                additionalDirectories,
                agentId: session.agentId,
                directoryId: directory.directoryId,
                directoryLabel: directory.label,
                prompted: session.prompted,
                sessionId: session.sessionId,
                status: this.#sessions.sessionStatus(session.sessionId),
                title: session.title || "Untitled session",
                updatedAt: session.updatedAt,
            });
        }
        return entries;
    };

    private readonly authorizeEntry = async (
        command: NativeSessionCommand,
        options: SessionPrepareOptions,
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
        options: SessionPrepareOptions,
        selected: ListedTarget,
    ): Promise<AuthorizedNativeSession> => {
        const info = await options.adapter
            .findSession(options, selected.nativeSessionId, {
                maximumPages: 100,
                maximumEntries: null,
            })
            .catch((cause: unknown) => {
                options.signal.throwIfAborted();
                if (cause instanceof AcpExecutionError && cause.code === "native_session_not_found") {
                    throw new AcpExecutionError(
                        "The selected native session no longer exists. Refresh the list.",
                        { cause },
                        "native_session_not_found",
                    );
                }
                throw cause;
            });
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
    };
}
