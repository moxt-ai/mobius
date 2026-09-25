import type { NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "./acp-error.ts";
import type { AgentProcessPool } from "./agent-process-pool.ts";
import { AgentSession } from "./agent-session.ts";
import { RetainedAgentProcesses } from "./retained-agent-processes.ts";
import { type AcpPreparedSession, type AcpPrepareOptions, NullAcpSessionObserver } from "./session-contracts.ts";
import { MemoryAcpSessionStore } from "./session-store.ts";

/** Owns query processes; execution processes remain separately retained. */
export class AgentQueryProcesses {
    readonly #processesByQuery: RetainedAgentProcesses;
    readonly #processes: AgentProcessPool;
    readonly #observer = new NullAcpSessionObserver();
    readonly #store = new MemoryAcpSessionStore();

    constructor(processes: AgentProcessPool) {
        this.#processes = processes;
        this.#processesByQuery = new RetainedAgentProcesses({
            touch: processes.touch,
            changed: processes.notifyChanged,
        });
    }
    readonly retire = async (sessionId: string, runtime: AgentSession): Promise<void> => {
        const retained = this.#processesByQuery.detach(sessionId, runtime);
        if (retained) {
            this.#store.remove(sessionId);
        }
        await this.#processes.retire(runtime, () => runtime.close());
    };

    async #startRetained(options: AcpPrepareOptions): Promise<AgentSession> {
        const runtime = await this.#processes.startRetained(
            options.signal,
            () => AgentSession.startNativeSessionBrowser(options, () => this.#observer, this.#store),
            {
                isBusy: () => this.#processesByQuery.isBusy(options.sessionId),
                retire: (runtime) => this.retire(options.sessionId, runtime),
            },
        );
        this.#processesByQuery.retain(options.sessionId, runtime);
        return runtime;
    }

    async #startPreparation(options: AcpPrepareOptions): Promise<AgentSession> {
        return await this.#processesByQuery.prepare(options.sessionId, async () => {
            return await this.#startRetained(options);
        });
    }

    async #replacePreparation(existing: AgentSession, options: AcpPrepareOptions): Promise<AgentSession> {
        return await this.#processesByQuery.prepare(options.sessionId, async () => {
            await this.retire(options.sessionId, existing);
            return await this.#startRetained(options);
        });
    }

    readonly prepare = async (options: AcpPrepareOptions): Promise<AcpPreparedSession> => {
        const pending = this.#processesByQuery.pending(options.sessionId);
        if (pending !== undefined) {
            const runtime = await pending;
            if (runtime.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#processesByQuery.touch(options.sessionId, runtime);
                return runtime.prepared();
            }
            return await this.prepare(options);
        }
        const existing = this.#processesByQuery.get(options.sessionId);
        if (existing !== undefined) {
            if (existing.belongsTo(options.agent.id, options.cwd, options.additionalDirectories)) {
                this.#processesByQuery.touch(options.sessionId, existing);
                return existing.prepared();
            }
            if (!existing.canRebind()) {
                throw new AcpExecutionError(
                    "The agent or workspace cannot change after a conversation has started",
                    {},
                    "session_identity_mismatch",
                );
            }
            const runtime = await this.#replacePreparation(existing, options);
            return runtime.prepared();
        }
        const runtime = await this.#startPreparation(options);
        return runtime.prepared();
    };

    async #ensure(options: AcpPrepareOptions): Promise<AgentSession> {
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
        await this.prepare(options);
        const started = this.#processesByQuery.get(options.sessionId);
        if (started === undefined) {
            throw new AcpExecutionError("ACP native session browser did not start");
        }
        return started;
    }

    readonly use = async <T>(
        options: AcpPrepareOptions,
        operation: (runtime: AgentSession) => Promise<T>,
    ): Promise<T> =>
        await this.#processesByQuery.use(options.sessionId, async () => await operation(await this.#ensure(options)));

    readonly preview = async (options: AcpPrepareOptions, nativeSessionId: string): Promise<NativeSessionHistory> => {
        return await this.#processes.runTransient(
            options.signal,
            async () =>
                await AgentSession.startNativeSessionBrowser(
                    options,
                    () => this.#observer,
                    new MemoryAcpSessionStore(),
                ),
            async (runtime) => {
                runtime.selectNativeSession(nativeSessionId);
                return await runtime.loadHistory(options.signal);
            },
            async (runtime) => await runtime.closeProcess(),
        );
    };

    readonly close = async (): Promise<void> => {
        await Promise.all(
            this.#processesByQuery.entries().map(async ([id, runtime]) => await this.retire(id, runtime)),
        );
    };
}
