import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk";
import { arraysEqual } from "../../../util/value-utils.ts";
import { AcpExecutionError } from "../../acp-error.ts";
import { agentOperationError, waitForAgentOperation } from "../../connection/agent-operation.ts";
import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import type { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import { type NativeSessionId, nativeSessionIdSchema } from "../../protocol/native-session.ts";
import { type PiCallbackParams, piClientCallbacks } from "./client-callbacks.ts";
import { createPiClient, type PiClientRuntime } from "./create-client.ts";

/** How long Pi may take to acknowledge a turn cancellation before its process is retired. */
const CANCEL_TIMEOUT_MILLISECONDS = 30_000;

export interface PiWorkspace {
    readonly cwd: string;
    readonly additionalDirectories: readonly string[];
}

export interface PiSessionStartParams {
    readonly runtime: PiClientRuntime;
    readonly workspace: PiWorkspace;
    readonly callbacks: PiCallbackParams;
    readonly externalizer: Pick<AcpContentExternalizer, "update">;
    readonly signal: AbortSignal;
}

/**
 * One Pi client bound to one native session. Pi keeps a single live session per client,
 * so a PiSession exists only after Pi has accepted the session it owns.
 */
export class PiSession {
    readonly nativeSessionId: NativeSessionId;
    readonly workspace: PiWorkspace;
    readonly agent: PiAcpAgent;
    readonly #lifetime: AbortController;
    readonly #drained: () => Promise<void>;

    private constructor(
        nativeSessionId: NativeSessionId,
        workspace: PiWorkspace,
        agent: PiAcpAgent,
        lifetime: AbortController,
        drained: () => Promise<void>,
    ) {
        this.nativeSessionId = nativeSessionId;
        this.workspace = workspace;
        this.agent = agent;
        this.#lifetime = lifetime;
        this.#drained = drained;
    }

    /** Runs `start` on a new client; returns the bound session, or disposes the client and throws. */
    static readonly start = async <Response extends { readonly sessionId: string }>(
        params: PiSessionStartParams,
        start: (agent: PiAcpAgent) => Promise<Response>,
    ): Promise<{ readonly session: PiSession; readonly response: Response }> => {
        const lifetime = new AbortController();
        const callbacks = piClientCallbacks(params.callbacks, params.externalizer, {
            signal: lifetime.signal,
            fail: (cause) => lifetime.abort(cause),
        });
        const agent = await createPiClient(params.runtime, callbacks, params.signal);
        try {
            const response = await waitForAgentOperation(start(agent), params.signal);
            lifetime.signal.throwIfAborted();
            const nativeSessionId = nativeSessionIdSchema.parse(response.sessionId);
            return {
                session: new PiSession(nativeSessionId, params.workspace, agent, lifetime, callbacks.drained),
                response,
            };
        } catch (cause) {
            lifetime.abort(cause);
            await agent.dispose();
            params.signal.throwIfAborted();
            throw agentOperationError(cause);
        }
    };

    /** False after an event callback failed or the client closed; the owner must release it. */
    get available(): boolean {
        return !this.#lifetime.signal.aborted && !this.agent.signal.aborted;
    }

    readonly assertWorkspace = (workspace: PiWorkspace): void => {
        if (
            this.workspace.cwd !== workspace.cwd ||
            !arraysEqual(this.workspace.additionalDirectories, workspace.additionalDirectories)
        ) {
            throw new AcpExecutionError("The native session workspace cannot change", {}, "session_identity_mismatch");
        }
    };

    /**
     * Settles when the turn and all of its events have been delivered. Aborting the caller signal,
     * or a failed event delivery, stops waiting immediately and asks Pi to stop the turn.
     */
    readonly prompt = async (
        request: Omit<PromptRequest, "sessionId">,
        signal: AbortSignal,
    ): Promise<PromptResponse> => {
        signal.throwIfAborted();
        this.#lifetime.signal.throwIfAborted();
        const stopped = AbortSignal.any([signal, this.#lifetime.signal]);
        const stopTurn = (): void => {
            if (!this.agent.signal.aborted) {
                void this.cancel(new AbortController().signal).catch(() => undefined);
            }
        };
        stopped.addEventListener("abort", stopTurn, { once: true });
        try {
            const response = await waitForAgentOperation(
                this.agent.prompt({ ...request, sessionId: this.nativeSessionId }),
                stopped,
            );
            await waitForAgentOperation(this.#drained(), stopped);
            return response;
        } catch (cause) {
            signal.throwIfAborted();
            // A failed delivery is the turn's failure, not a later session_busy.
            this.#lifetime.signal.throwIfAborted();
            throw cause;
        } finally {
            stopped.removeEventListener("abort", stopTurn);
        }
    };

    /** Retires the process when Pi does not acknowledge cancellation before the deadline. */
    readonly cancel = async (signal: AbortSignal): Promise<"retained" | "closed"> => {
        signal.throwIfAborted();
        const deadline = AbortSignal.timeout(CANCEL_TIMEOUT_MILLISECONDS);
        try {
            await waitForAgentOperation(
                this.agent.cancel({ sessionId: this.nativeSessionId }),
                AbortSignal.any([signal, deadline]),
            );
            return "retained";
        } catch (cause) {
            signal.throwIfAborted();
            if (!deadline.aborted) {
                throw cause;
            }
            await this.dispose();
            return "closed";
        }
    };

    readonly dispose = (): Promise<void> => {
        // Close the client first so turn listeners see a closed client, not a stop request.
        const closing = this.agent.dispose();
        this.#lifetime.abort(new DOMException("The Pi session was released", "AbortError"));
        return closing;
    };
}
