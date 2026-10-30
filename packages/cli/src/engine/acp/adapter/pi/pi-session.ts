import type { PromptRequest, PromptResponse } from "@agentclientprotocol/sdk";
import { arraysEqual } from "../../../util/value-utils.ts";
import { AcpExecutionError } from "../../acp-error.ts";
import { agentOperationError, waitForAgentOperation } from "../../connection/agent-operation.ts";
import type { AcpContentExternalizer } from "../../content/content-externalizer.ts";
import type { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import { type NativeSessionId, nativeSessionIdSchema } from "../../protocol/native-session.ts";
import { type PiCallbackParams, piClientCallbacks } from "./client-callbacks.ts";
import { createPiClient, type PiClientRuntime } from "./create-client.ts";

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

    private constructor(
        nativeSessionId: NativeSessionId,
        workspace: PiWorkspace,
        agent: PiAcpAgent,
        lifetime: AbortController,
    ) {
        this.nativeSessionId = nativeSessionId;
        this.workspace = workspace;
        this.agent = agent;
        this.#lifetime = lifetime;
    }

    /** Runs `start` on a new client; returns the bound session, or disposes the client and throws. */
    static readonly start = async <Response extends { readonly sessionId: string }>(
        params: PiSessionStartParams,
        start: (agent: PiAcpAgent) => Promise<Response>,
    ): Promise<{ readonly session: PiSession; readonly response: Response }> => {
        const lifetime = new AbortController();
        const agent = await createPiClient(
            params.runtime,
            piClientCallbacks(params.callbacks, params.externalizer, {
                signal: lifetime.signal,
                fail: (cause) => lifetime.abort(cause),
            }),
            params.signal,
        );
        try {
            const response = await waitForAgentOperation(start(agent), params.signal);
            lifetime.signal.throwIfAborted();
            const nativeSessionId = nativeSessionIdSchema.parse(response.sessionId);
            return { session: new PiSession(nativeSessionId, params.workspace, agent, lifetime), response };
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

    /** Aborting the signal cancels the running turn; the session stays usable. */
    readonly prompt = async (
        request: Omit<PromptRequest, "sessionId">,
        signal: AbortSignal,
    ): Promise<PromptResponse> => {
        signal.throwIfAborted();
        let cancellation: Promise<void> = Promise.resolve();
        const cancel = (): void => {
            cancellation = this.agent.cancel({ sessionId: this.nativeSessionId }).catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
            const response = await this.agent.prompt({ ...request, sessionId: this.nativeSessionId });
            signal.throwIfAborted();
            return response;
        } catch (cause) {
            signal.throwIfAborted();
            throw agentOperationError(cause);
        } finally {
            signal.removeEventListener("abort", cancel);
            await cancellation;
        }
    };

    readonly dispose = (): Promise<void> => {
        this.#lifetime.abort(new DOMException("The Pi session was released", "AbortError"));
        return this.agent.dispose();
    };
}
