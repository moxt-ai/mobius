import type { SessionCapabilities } from "@moxt-ai/mobius-sdk/protocol";
import { MemorySessionEventStore, type SessionEventPage } from "../../session/history/session-event-store.ts";
import { waitForSharedOperation } from "../../session/manager/operation-drain.ts";
import type { AgentProcessPool } from "../../session/process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../../session/process/retained-agent-processes.ts";
import { AcpExecutionError } from "../acp-error.ts";
import type { NativeSessionPreviewRequest, NativeSessionQuery } from "../native-history/preview-contract.ts";
import type { NativeSessionPage } from "../protocol/native-session.ts";
import { AcpQuerySession } from "./query-session.ts";
import type { AcpSessionConnector } from "./session-events.ts";

/** Owns query processes; execution processes remain separately retained. */
export class AgentQueryProcesses {
    readonly #eventPreviewsBySession = new Map<
        string,
        { readonly nativeSessionId: string; readonly store: MemorySessionEventStore }
    >();
    readonly #processesByQuery: RetainedAgentProcesses<AcpQuerySession>;
    readonly #processes: AgentProcessPool;
    readonly #store = new MemorySessionEventStore();
    readonly #connector: AcpSessionConnector;

    constructor(processes: AgentProcessPool, connector: AcpSessionConnector) {
        this.#processes = processes;
        this.#connector = connector;
        this.#processesByQuery = new RetainedAgentProcesses<AcpQuerySession>({
            touch: processes.touch,
            changed: processes.notifyChanged,
        });
    }
    readonly retire = async (sessionId: string, runtime: AcpQuerySession): Promise<void> => {
        const retained = this.#processesByQuery.detach(sessionId, runtime);
        if (retained) {
            this.#store.remove(sessionId);
        }
        await this.#processes.retire(runtime, () => runtime.closeProcess());
    };

    async #startRetained(options: NativeSessionQuery): Promise<AcpQuerySession> {
        const runtime = await this.#processes.startRetained(
            options.signal,
            () => AcpQuerySession.start(options, this.#store, this.#connector),
            {
                isBusy: () => this.#processesByQuery.isBusy(options.sessionId),
                retire: (runtime) => this.retire(options.sessionId, runtime),
                retireIdle: (runtime) => this.retire(options.sessionId, runtime),
            },
        );
        this.#processesByQuery.retain(options.sessionId, runtime);
        return runtime;
    }

    async #startPreparation(options: NativeSessionQuery): Promise<AcpQuerySession> {
        return await this.#processesByQuery.prepare(options.sessionId, async () => {
            return await this.#startRetained(options);
        });
    }

    async #replacePreparation(existing: AcpQuerySession, options: NativeSessionQuery): Promise<AcpQuerySession> {
        return await this.#processesByQuery.prepare(options.sessionId, async () => {
            await this.retire(options.sessionId, existing);
            return await this.#startRetained(options);
        });
    }

    readonly #prepare = async (options: NativeSessionQuery): Promise<SessionCapabilities> => {
        const pending = this.#processesByQuery.pending(options.sessionId);
        if (pending !== undefined) {
            const runtime = await waitForSharedOperation(pending, options.signal);
            if (runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#processesByQuery.touch(options.sessionId, runtime);
                return runtime.capabilities();
            }
            return await this.#prepare(options);
        }
        const existing = this.#processesByQuery.get(options.sessionId);
        if (existing !== undefined) {
            if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#processesByQuery.touch(options.sessionId, existing);
                return existing.capabilities();
            }
            const runtime = await this.#replacePreparation(existing, options);
            return runtime.capabilities();
        }
        const runtime = await this.#startPreparation(options);
        return runtime.capabilities();
    };

    async #ensure(options: NativeSessionQuery): Promise<AcpQuerySession> {
        const existing = this.#processesByQuery.get(options.sessionId);
        if (existing !== undefined) {
            if (!existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            this.#processesByQuery.touch(options.sessionId, existing);
            return existing;
        }
        await this.#prepare(options);
        const started = this.#processesByQuery.get(options.sessionId);
        if (started === undefined) {
            throw new AcpExecutionError("ACP native session browser did not start");
        }
        return started;
    }

    readonly #use = async <T>(
        options: NativeSessionQuery,
        operation: (runtime: AcpQuerySession) => Promise<T>,
    ): Promise<T> =>
        await this.#processesByQuery.use(options.sessionId, async () => await operation(await this.#ensure(options)));

    readonly capabilities = async (query: NativeSessionQuery): Promise<SessionCapabilities> =>
        await this.#prepare(query);

    readonly listNativeSessions = async (
        query: NativeSessionQuery,
        cursor: string | null,
    ): Promise<NativeSessionPage> =>
        await this.#use(query, async (runtime) => await runtime.listNativeSessions(cursor, query.signal));

    readonly previewSessionEvents = async (
        options: NativeSessionQuery,
        request: NativeSessionPreviewRequest,
    ): Promise<SessionEventPage> => {
        const { nativeSessionId, eventLimit, cursor } = request;
        if (cursor !== null) {
            const preview = this.#eventPreviewsBySession.get(options.sessionId);
            if (preview === undefined || preview.nativeSessionId !== nativeSessionId) {
                throw new Error("The native event cursor is invalid");
            }
            return preview.store.page(options.sessionId, eventLimit, cursor);
        }
        const store = new MemorySessionEventStore();
        const previous = this.#eventPreviewsBySession.get(options.sessionId);
        previous?.store.close();
        this.#eventPreviewsBySession.set(options.sessionId, { nativeSessionId, store });
        try {
            return await this.#processes.runTransient(
                options.signal,
                async () => await AcpQuerySession.start(options, store, this.#connector),
                async (runtime) => await runtime.previewEvents(nativeSessionId, eventLimit, options.signal),
                async (runtime) => await runtime.closeProcess(),
            );
        } catch (error) {
            if (this.#eventPreviewsBySession.get(options.sessionId)?.store === store) {
                this.#eventPreviewsBySession.delete(options.sessionId);
            }
            store.close();
            throw error;
        }
    };

    readonly close = async (): Promise<void> => {
        await Promise.all(
            this.#processesByQuery.entries().map(async ([id, runtime]) => await this.retire(id, runtime)),
        );
        for (const preview of this.#eventPreviewsBySession.values()) {
            preview.store.close();
        }
        this.#eventPreviewsBySession.clear();
        this.#store.close();
    };
}
