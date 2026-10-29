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
    readonly #processesByAgent = new Map<AcpAgentDefinition, RetainedAgentProcesses<AcpQuerySession>>();
    #agent: AcpAgentDefinition;
    readonly #processes: AgentProcessPool;
    readonly #store = new MemorySessionEventStore();
    readonly #connector: AcpSessionConnector;

    constructor(agent: AcpAgentDefinition, processes: AgentProcessPool, connector: AcpSessionConnector) {
        this.#agent = agent;
        this.#processes = processes;
        this.#connector = connector;
    }

    readonly refreshAgent = (agent: AcpAgentDefinition): void => {
        this.#agent = agent;
    };

    readonly retire = async (
        readers: RetainedAgentProcesses<AcpQuerySession>,
        cwd: string,
        runtime: AcpQuerySession,
    ): Promise<void> => {
        readers.detach(cwd, runtime);
        try {
            await this.#processes.retire(runtime, () => runtime.closeProcess());
        } finally {
            runtime.discardEvents();
        }
    };

    async #ensure(
        agent: AcpAgentDefinition,
        readers: RetainedAgentProcesses<AcpQuerySession>,
        cwd: string,
        signal: AbortSignal,
    ): Promise<AcpQuerySession> {
        signal.throwIfAborted();
        const pending = readers.pending(cwd);
        if (pending !== undefined) {
            return await waitForSharedOperation(pending, signal);
        }
        const existing = readers.get(cwd);
        if (existing !== undefined) {
            readers.touch(cwd, existing);
            return existing;
        }
        return await readers.prepare(cwd, async () => {
            // This ID belongs to the reader, never to a user's conversation.
            const readerId = randomUUID();
            const runtime = await this.#processes.startRetained(
                signal,
                () => AcpQuerySession.start(agent, cwd, readerId, this.#store, this.#connector, signal),
                {
                    isBusy: () => readers.isBusy(cwd),
                    retire: (runtime) => this.retire(readers, cwd, runtime),
                    retireIdle: (runtime) => this.retire(readers, cwd, runtime),
                },
            );
            readers.retain(cwd, runtime);
            return runtime;
        });
    }

    readonly #use = async <T>(
        cwd: string,
        signal: AbortSignal,
        operation: (runtime: AcpQuerySession) => Promise<T>,
    ): Promise<T> => {
        // Capture one immutable definition for this operation, including while it waits for capacity.
        const agent = this.#agent;
        let readers = this.#processesByAgent.get(agent);
        if (readers === undefined) {
            readers = new RetainedAgentProcesses<AcpQuerySession>({
                touch: this.#processes.touch,
                changed: this.#processes.notifyChanged,
            });
            this.#processesByAgent.set(agent, readers);
        }
        const current = readers;
        return await current.use(cwd, async () => await operation(await this.#ensure(agent, current, cwd, signal)));
    };

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
        const agent = this.#agent;
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
                async () => await AcpQuerySession.start(agent, cwd, sessionId, store, this.#connector, signal),
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
            [...this.#processesByAgent.values()].flatMap((readers) =>
                readers.entries().map(async ([cwd, runtime]) => await this.retire(readers, cwd, runtime)),
            ),
        );
        this.#processesByAgent.clear();
        for (const preview of this.#eventPreviewsBySession.values()) {
            preview.store.close();
        }
        this.#eventPreviewsBySession.clear();
        this.#store.close();
    };
}
