import { AcpExecutionError } from "../../acp/acp-error.ts";
import type { AdapterSessionOpened } from "../../acp/native-history/preview-contract.ts";
import { type NativeSessionOrigin, nativeSessionIdSchema } from "../../acp/protocol/native-session.ts";
import { arraysEqual } from "../../util/value-utils.ts";
import type { SessionRecovery } from "../api/session-api.ts";
import { FoundStoredSession, StoredSession } from "../record/session-store.ts";
import type { AgentSessionRestore } from "./agent-session-restore.ts";

function hasMethodNotFoundCode(cause: unknown): boolean {
    const visited = new Set<unknown>();
    let current: unknown = cause;
    while ((current instanceof Error || (typeof current === "object" && current !== null)) && !visited.has(current)) {
        visited.add(current);
        const code = Reflect.get(current, "code");
        if (code === -32601 || code === "METHOD_NOT_FOUND" || code === "method_not_found") {
            return true;
        }
        current = current instanceof Error ? current.cause : undefined;
    }
    return false;
}

/**
 * Decides how the conversation is established and performs it: fork the native session,
 * restore the stored one (session/load or session/resume), or start a new one. The session
 * keeps every piece of mutable state; this function reads and writes it through the
 * restore surface AgentSession exposes.
 */
export async function restoreSession(
    session: AgentSessionRestore,
    signal: AbortSignal,
    recovery: SessionRecovery,
    origin?: NativeSessionOrigin,
): Promise<void> {
    if (origin !== undefined) {
        session.setSessionTitle(origin.title);
    }
    const stored = session.metrics.measureSync("session-state-read", () =>
        origin?.kind === "import"
            ? new FoundStoredSession(
                  new StoredSession(
                      session.sessionId,
                      session.agentId,
                      nativeSessionIdSchema.parse(origin.nativeSessionId),
                      session.cwd,
                      session.additionalDirectories,
                      true,
                      origin.title,
                  ),
              )
            : session.store.read(session.sessionId),
    );
    const sameConversation = (record: StoredSession): boolean =>
        record.agentId === session.agentId &&
        record.cwd === session.cwd &&
        arraysEqual(record.additionalDirectories, session.additionalDirectories);
    // A prompted Session continues its native conversation. Until its first prompt a Session has none worth
    // continuing (the Agent may not have kept it), so it opens a new one but keeps its own title and settings,
    // unless its Agent or workspace changed.
    const conversation = stored instanceof FoundStoredSession && stored.session.prompted ? stored.session : undefined;
    const unprompted =
        origin?.kind !== "fork" &&
        stored instanceof FoundStoredSession &&
        !stored.session.prompted &&
        sameConversation(stored.session)
            ? stored.session
            : undefined;
    if (stored instanceof FoundStoredSession && !stored.session.prompted && unprompted === undefined) {
        session.store.remove(session.sessionId);
    }
    // A fork has a new Runtime identity, so its destination has no saved selections.
    // Snapshot the locally tracked source before opening the independent Agent session.
    const forkSource =
        origin?.kind === "fork" ? session.store.findNative(session.agentId, origin.nativeSessionId)[0] : undefined;

    let opened: AdapterSessionOpened;
    if (origin?.kind === "fork") {
        if (!session.capabilities.unstableForkSession) {
            throw new AcpExecutionError(
                "This Agent does not support session forking",
                {},
                "native_session_unsupported",
            );
        }
        if (session.additionalDirectories.length > 0 && !session.capabilities.additionalDirectories) {
            throw new AcpExecutionError(
                "This Agent cannot restore additional working directories",
                {},
                "native_session_unsupported",
            );
        }
        const forked = await session.metrics.measure(
            "session-fork",
            async () => await session.forkSession(origin.nativeSessionId, signal),
        );
        session.selectNativeSession(forked.nativeSessionId);
        if (
            session.nativeSessionId() === origin.nativeSessionId ||
            session.store.findNative(session.agentId, session.nativeSessionId()).length > 0
        ) {
            throw new AcpExecutionError(
                "The Agent did not create an independent fork",
                {},
                "invalid_native_session_response",
            );
        }
        session.setPrompted(true);
        session.setRestored(true);
        if (recovery.kind === "execution-only") {
            session.startExecutionOnlyCapture();
        }
        opened = forked;
    } else if (conversation !== undefined && sameConversation(conversation)) {
        session.selectNativeSession(conversation.nativeSessionId);
        session.setPrompted(conversation.prompted);
        session.setSessionTitle(conversation.title);
        session.setRestored(true);
        if (recovery.kind === "history-required") {
            if (!session.capabilities.loadSession) {
                throw new AcpExecutionError(
                    "This Agent restores context but does not provide message history.",
                    {},
                    "native_history_unsupported",
                );
            }
            opened = await session.metrics.measure(
                "session-load",
                async () => await session.openSessionWithReplay(signal),
            );
        } else if (recovery.kind === "execution-only") {
            try {
                opened = await session.metrics.measure("session-resume", async () => await session.openSession(signal));
            } catch (cause) {
                signal.throwIfAborted();
                if (cause instanceof AcpExecutionError && !hasMethodNotFoundCode(cause)) {
                    throw cause;
                }
                throw new AcpExecutionError(
                    "This Agent cannot continue a persisted session without replaying native history",
                    { cause },
                    "execution_only_unsupported",
                );
            }
            session.startExecutionOnlyCapture();
        } else if (session.capabilities.resumeSession) {
            opened = await session.metrics.measure("session-resume", async () => await session.openSession(signal));
        } else if (session.capabilities.loadSession) {
            opened = await session.metrics.measure(
                "session-load",
                async () => await session.openSessionWithReplay(signal),
            );
        } else {
            throw new AcpExecutionError(
                "The ACP agent cannot restore its persisted session",
                {},
                "session_restore_unsupported",
            );
        }
    } else {
        if (conversation !== undefined) {
            throw new AcpExecutionError(
                "The agent or workspace cannot change after a conversation has started",
                {},
                "session_identity_mismatch",
            );
        }
        if (unprompted !== undefined) {
            session.setSessionTitle(unprompted.title);
        }
        const created = await session.metrics.measure("session-new", async () => await session.createSession(signal));
        session.selectNativeSession(created.nativeSessionId);
        session.setNativeHistoryOwnership({ kind: "fresh-session" });
        if (recovery.kind === "execution-only") {
            session.startExecutionOnlyCapture();
        }
        opened = created;
    }
    session.applySessionOpened(opened);
    if (forkSource !== undefined) {
        await session.restoreStoredConfigurations(forkSource, signal, "fork");
    } else if (conversation !== undefined && session.restored) {
        await session.restoreStoredConfigurations(conversation, signal);
    } else if (unprompted !== undefined) {
        await session.restoreStoredConfigurations(unprompted, signal);
    }
    signal.throwIfAborted();
    session.writeStoredSession(
        conversation !== undefined && session.restored ? conversation.updatedAt : new Date().toISOString(),
    );
}
