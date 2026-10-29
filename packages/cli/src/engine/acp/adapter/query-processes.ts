import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import { MemorySessionEventStore, type SessionEventPage } from "../../session/history/session-event-store.ts";
import { waitForSharedOperation } from "../../session/manager/operation-drain.ts";
import type { AgentProcessPool } from "../../session/process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../../session/process/retained-agent-processes.ts";
import type { AcpAgentDefinition } from "../agent/agent-definition.ts";
import type { NativeSessionPreviewRequest, NativeSessionQuery } from "../native-history/preview-contract.ts";
import type { NativeSessionPage } from "../protocol/native-session.ts";
import {
    type NativeSessionPreviewKey,
    type NativeSessionQueryKey,
    nativeSessionPreviewKey,
    nativeSessionQueryKey,
} from "./query-scope.ts";
import { AcpQuerySession } from "./query-session.ts";
import type { AcpSessionConnector } from "./session-events.ts";

/** Owns workspace-scoped readers, independently of execution conversations. */
export class AgentQueryProcesses {
    readonly #eventPreviewsBySession = new Map<
        NativeSessionPreviewKey,
        { readonly nativeSessionId: string; readonly store: MemorySessionEventStore }
    >();
    readonly #processesByAgent = new Map<
        AcpAgentDefinition,
        RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>
    >();
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
        readers: RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>,
        key: NativeSessionQueryKey,
        runtime: AcpQuerySession,
    ): Promise<void> => {
        readers.detach(key, runtime);
        try {
            await this.#processes.retire(runtime, () => runtime.closeProcess());
        } finally {
            runtime.discardEvents();
        }
    };

    async #ensure(
        readers: RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>,
        query: NativeSessionQuery,
    ): Promise<AcpQuerySession> {
        query.signal.throwIfAborted();
        const key = nativeSessionQueryKey(query);
        const pending = readers.pending(key);
        if (pending !== undefined) {
            return await waitForSharedOperation(pending, query.signal);
        }
        const existing = readers.get(key);
        if (existing !== undefined && !existing.hasTerminated()) {
            readers.touch(key, existing);
            return existing;
        }
        return await readers.prepare(key, async () => {
            if (existing !== undefined) {
                await this.retire(readers, key, existing);
            }
            const runtime = await this.#processes.startRetained(
                query.signal,
                () => AcpQuerySession.start(query, this.#store, this.#connector),
                {
                    isBusy: () => readers.isBusy(key),
                    retire: (runtime) => this.retire(readers, key, runtime),
                    retireIdle: (runtime) => this.retire(readers, key, runtime),
                },
            );
            readers.retain(key, runtime);
            return runtime;
        });
    }

    readonly #use = async <T>(
        query: NativeSessionQuery,
        operation: (runtime: AcpQuerySession) => Promise<T>,
    ): Promise<T> => {
        // Capture one immutable catalog definition while waiting for capacity.
        const agent = this.#agent;
        const scoped = { ...query, agent };
        let readers = this.#processesByAgent.get(agent);
        if (readers === undefined) {
            readers = new RetainedAgentProcesses<AcpQuerySession, NativeSessionQueryKey>({
                touch: this.#processes.touch,
                changed: this.#processes.notifyChanged,
            });
            this.#processesByAgent.set(agent, readers);
        }
        const current = readers;
        return await current.use(
            nativeSessionQueryKey(scoped),
            async () => await operation(await this.#ensure(current, scoped)),
        );
    };

    readonly capabilities = async (query: NativeSessionQuery): Promise<SessionCapabilities> =>
        await this.#use(query, async (runtime) => runtime.capabilities());

    readonly listNativeSessions = async (
        query: NativeSessionQuery,
        cursor: string | null,
    ): Promise<NativeSessionPage> =>
        await this.#use(query, async (runtime) => await runtime.listNativeSessions(cursor, query.signal));

    readonly previewSessionEvents = async (
        query: NativeSessionQuery,
        request: NativeSessionPreviewRequest,
    ): Promise<SessionEventPage> => {
        query.signal.throwIfAborted();
        const scoped = { ...query, agent: this.#agent };
        const { nativeSessionId, eventLimit, cursor } = request;
        const key = nativeSessionPreviewKey(nativeSessionQueryKey(scoped), nativeSessionId);
        if (cursor !== null) {
            const preview = this.#eventPreviewsBySession.get(key);
            if (preview === undefined || preview.nativeSessionId !== nativeSessionId) {
                throw new Error("The native event cursor is invalid");
            }
            return preview.store.page(nativeSessionId, eventLimit, cursor);
        }
        const store = new MemorySessionEventStore();
        this.#eventPreviewsBySession.get(key)?.store.close();
        this.#eventPreviewsBySession.set(key, { nativeSessionId, store });
        try {
            return await this.#processes.runTransient(
                query.signal,
                () => AcpQuerySession.start(scoped, store, this.#connector),
                (runtime) => runtime.previewEvents(nativeSessionId, eventLimit, query.signal),
                (runtime) => runtime.closeProcess(),
            );
        } catch (error) {
            if (this.#eventPreviewsBySession.get(key)?.store === store) {
                this.#eventPreviewsBySession.delete(key);
            }
            store.close();
            throw error;
        }
    };

    readonly close = async (): Promise<void> => {
        await Promise.all(
            [...this.#processesByAgent.values()].flatMap((readers) =>
                readers.entries().map(async ([key, runtime]) => await this.retire(readers, key, runtime)),
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
