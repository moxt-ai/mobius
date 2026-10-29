import type { AgentProcessPool } from "./agent-process-pool.ts";

/** The Agent process pools of a daemon's running Runtimes, released together on a local request. */
export class RuntimeAgentProcesses {
    readonly #pools = new Set<Pick<AgentProcessPool, "retireIdleProcesses">>();

    /** Tracks a Runtime's pool until the returned function removes it. */
    readonly add = (pool: Pick<AgentProcessPool, "retireIdleProcesses">): (() => void) => {
        this.#pools.add(pool);
        return () => {
            this.#pools.delete(pool);
        };
    };

    readonly retireIdleProcesses = async (): Promise<void> => {
        await Promise.all([...this.#pools].map(async (pool) => await pool.retireIdleProcesses()));
    };
}
