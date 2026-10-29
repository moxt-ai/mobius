import { randomUUID } from "node:crypto";
import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import { MemorySessionEventStore, type SessionEventPage } from "../../session/history/session-event-store.ts";
import { waitForSharedOperation } from "../../session/manager/operation-drain.ts";
import type { AgentProcessPool } from "../../session/process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../../session/process/retained-agent-processes.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { NativeSessionPreviewRequest } from "../native-history/preview-contract.ts";
import type { NativeSessionPage } from "../protocol/native-session.ts";
import { AcpQuerySession } from "./query-session.ts";
import type { AcpSessionConnector } from "./session-events.ts";

/** Owns workspace-scoped readers, independently of execution conversations. */
export class AgentQueryProcesses {
    readonly #eventPreviewsBySession = new Map<
        string,
        { readonly nativeSessionId: string; readonly store: MemorySessionEventStore }
    >();
    readonly #processesByQuery: RetainedAgentProcesses<AcpQuerySession>;
    readonly #agent: AcpAgentDefinition;
    readonly #processes: AgentProcessPool;
    readonly #store = new MemorySessionEventStore();
    readonly #connector: AcpSessionConnector;

    constructor(agent: AcpAgentDefinition, processes: AgentProcessPool, connector: AcpSessionConnector) {
        this.#agent = agent;
        this.#processes = processes;
        this.#connector = connector;
        this.#processesByQuery = new RetainedAgentProcesses<AcpQuerySession>({
            touch: processes.touch,
            changed: processes.notifyChanged,
        });
    }

    readonly retire = async (cwd: string, runtime: AcpQuerySession): Promise<void> => {
        this.#processesByQuery.detach(cwd, runtime);
        try {
            await this.#processes.retire(runtime, () => runtime.closeProcess());
        } finally {
            runtime.discardEvents();
        }
    };

    async #ensure(cwd: string, signal: AbortSignal): Promise<AcpQuerySession> {
        signal.throwIfAborted();
        const pending = this.#processesByQuery.pending(cwd);
        if (pending !== undefined) {
            return await waitForSharedOperation(pending, signal);
        }
        const existing = this.#processesByQuery.get(cwd);
        if (existing !== undefined) {
            this.#processesByQuery.touch(cwd, existing);
            return existing;
        }
        return await this.#processesByQuery.prepare(cwd, async () => {
            // This ID belongs to the reader, never to a user's conversation.
            const readerId = randomUUID();
            const runtime = await this.#processes.startRetained(
                signal,
                () => AcpQuerySession.start(this.#agent, cwd, readerId, this.#store, this.#connector, signal),
                {
                    isBusy: () => this.#processesByQuery.isBusy(cwd),
                    retire: (runtime) => this.retire(cwd, runtime),
                    retireIdle: (runtime) => this.retire(cwd, runtime),
                },
            );
            this.#processesByQuery.retain(cwd, runtime);
            return runtime;
        });
    }

    readonly #use = async <T>(
        cwd: string,
        signal: AbortSignal,
        operation: (runtime: AcpQuerySession) => Promise<T>,
    ): Promise<T> =>
        await this.#processesByQuery.use(cwd, async () => await operation(await this.#ensure(cwd, signal)));

    readonly capabilities = async (cwd: string, signal: AbortSignal): Promise<SessionCapabilities> =>
        await this.#use(cwd, signal, async (runtime) => runtime.capabilities());

    readonly listNativeSessions = async (
        cwd: string,
        cursor: string | null,
        signal: AbortSignal,
    ): Promise<NativeSessionPage> =>
        await this.#use(cwd, signal, async (runtime) => await runtime.listNativeSessions(cursor, signal));

    readonly previewSessionEvents = async (
        cwd: string,
        additionalDirectories: readonly string[],
        request: NativeSessionPreviewRequest,
        signal: AbortSignal,
    ): Promise<SessionEventPage> => {
        signal.throwIfAborted();
        const { nativeSessionId, eventLimit, cursor, sessionId } = request;
        if (cursor !== null) {
            const preview = this.#eventPreviewsBySession.get(sessionId);
            if (preview === undefined || preview.nativeSessionId !== nativeSessionId) {
                throw new Error("The native event cursor is invalid");
            }
            return preview.store.page(sessionId, eventLimit, cursor);
        }
        const store = new MemorySessionEventStore();
        const previous = this.#eventPreviewsBySession.get(sessionId);
        previous?.store.close();
        this.#eventPreviewsBySession.set(sessionId, { nativeSessionId, store });
        try {
            return await this.#processes.runTransient(
                signal,
                async () => await AcpQuerySession.start(this.#agent, cwd, sessionId, store, this.#connector, signal),
                async (runtime) =>
                    await runtime.previewEvents(nativeSessionId, eventLimit, additionalDirectories, signal),
                async (runtime) => await runtime.closeProcess(),
            );
        } catch (error) {
            if (this.#eventPreviewsBySession.get(sessionId)?.store === store) {
                this.#eventPreviewsBySession.delete(sessionId);
            }
            store.close();
            throw error;
        }
    };

    readonly close = async (): Promise<void> => {
        await Promise.all(
            this.#processesByQuery.entries().map(async ([cwd, runtime]) => await this.retire(cwd, runtime)),
        );
        for (const preview of this.#eventPreviewsBySession.values()) {
            preview.store.close();
        }
        this.#eventPreviewsBySession.clear();
        this.#store.close();
    };
}
