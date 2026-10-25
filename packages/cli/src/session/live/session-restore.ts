import { methods } from "@agentclientprotocol/sdk";
import { AcpExecutionError } from "../../acp/acp-error.ts";
import { type NativeSessionOrigin, nativeSessionIdSchema } from "../../acp/protocol/native-session.ts";
import { arraysEqual } from "../../util/value-utils.ts";
import type { SessionRecovery } from "../api/session-api.ts";
import { FoundStoredSession, StoredSession } from "../record/session-store.ts";
import type { AgentSessionRestore } from "./agent-session-restore.ts";

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
    await session.initializeAgent(signal);
    let stored = session.metrics.measureSync("session-state-read", () =>
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
    if (stored instanceof FoundStoredSession && !stored.session.prompted) {
        session.store.remove(session.sessionId);
        stored = session.metrics.measureSync("session-state-read", () => session.store.read(session.sessionId));
    }

    let lifecycleResponse: unknown;
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
            async () =>
                await session.race(
                    session.agentRequest<Record<string, unknown>, { sessionId: string }>(
                        methods.agent.session.fork,
                        {
                            sessionId: nativeSessionIdSchema.parse(origin.nativeSessionId),
                            cwd: session.cwd,
                            additionalDirectories: [...session.additionalDirectories],
                            mcpServers: [],
                        },
                        { cancellationSignal: signal },
                    ),
                    "ACP agent exited while forking a session",
                    signal,
                ),
        );
        session.selectNativeSession(forked.sessionId);
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
        lifecycleResponse = forked;
    } else if (
        stored instanceof FoundStoredSession &&
        stored.session.agentId === session.agentId &&
        stored.session.cwd === session.cwd &&
        arraysEqual(stored.session.additionalDirectories, session.additionalDirectories)
    ) {
        session.selectNativeSession(stored.session.nativeSessionId);
        session.setPrompted(stored.session.prompted);
        session.setSessionTitle(stored.session.title);
        session.setRestored(true);
        if (recovery.kind === "history-required") {
            if (!session.capabilities.loadSession) {
                throw new AcpExecutionError(
                    "This Agent restores context but does not provide message history.",
                    {},
                    "native_history_unsupported",
                );
            }
            lifecycleResponse = await session.metrics.measure(
                "session-load",
                async () => (await session.loadSession(signal, "ACP agent exited while loading a session")).response,
            );
        } else if (recovery.kind === "execution-only") {
            try {
                lifecycleResponse = await session.metrics.measure(
                    "session-resume",
                    async () =>
                        await session.race(
                            session.agentRequest(
                                methods.agent.session.resume,
                                {
                                    additionalDirectories: [...session.additionalDirectories],
                                    cwd: session.cwd,
                                    mcpServers: [],
                                    sessionId: session.nativeSessionId(),
                                },
                                { cancellationSignal: signal },
                            ),
                            "ACP agent exited while resuming a session",
                            signal,
                        ),
                );
            } catch (cause) {
                signal.throwIfAborted();
                if (cause instanceof AcpExecutionError && cause.code !== "acp_agent_error") {
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
            lifecycleResponse = await session.metrics.measure(
                "session-resume",
                async () =>
                    await session.race(
                        session.agentRequest(
                            methods.agent.session.resume,
                            {
                                additionalDirectories: [...session.additionalDirectories],
                                cwd: session.cwd,
                                mcpServers: [],
                                sessionId: session.nativeSessionId(),
                            },
                            { cancellationSignal: signal },
                        ),
                        "ACP agent exited while resuming a session",
                        signal,
                    ),
            );
        } else if (session.capabilities.loadSession) {
            lifecycleResponse = await session.metrics.measure(
                "session-load",
                async () => (await session.loadSession(signal, "ACP agent exited while loading a session")).response,
            );
        } else {
            throw new AcpExecutionError(
                "The ACP agent cannot restore its persisted session",
                {},
                "session_restore_unsupported",
            );
        }
    } else {
        if (stored instanceof FoundStoredSession) {
            if (stored.session.prompted) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            session.store.remove(session.sessionId);
        }
        const created = await session.metrics.measure(
            "session-new",
            async () =>
                await session.race(
                    session.agentRequest<Record<string, unknown>, { sessionId: string }>(
                        methods.agent.session.new,
                        {
                            additionalDirectories: [...session.additionalDirectories],
                            cwd: session.cwd,
                            mcpServers: [],
                        },
                        { cancellationSignal: signal },
                    ),
                    "ACP agent exited while starting a session",
                    signal,
                ),
        );
        session.selectNativeSession(created.sessionId);
        session.setNativeHistoryOwnership({ kind: "fresh-session" });
        if (recovery.kind === "execution-only") {
            session.startExecutionOnlyCapture();
        }
        lifecycleResponse = created;
    }
    session.restrictSessionCapabilities(lifecycleResponse);
    session.setConfigOptions(session.sessionConfigProtocol.normalizeLifecycle(lifecycleResponse));
    if (stored instanceof FoundStoredSession && session.restored) {
        await session.restoreStoredConfigurations(stored.session, signal);
    }
    await session.drained();
    signal.throwIfAborted();
    session.writeStoredSession(
        stored instanceof FoundStoredSession && session.restored ? stored.session.updatedAt : new Date().toISOString(),
    );
}
