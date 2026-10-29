import { RuntimeOperations, waitForSharedOperation } from "../../../session/manager/operation-drain.ts";
import type { AgentProcessPool } from "../../../session/process/agent-process-pool.ts";
import { RetainedAgentProcesses } from "../../../session/process/retained-agent-processes.ts";
import { AcpExecutionError } from "../../acp-error.ts";
import type { PiAcpAgent } from "../../harness/pi/upstream/dist/acp/agent.js";
import type { PiAcpClient } from "../../harness/pi/upstream/dist/acp/client.js";
import { type NativeSessionId, nativeSessionIdSchema } from "../../protocol/native-session.ts";
import { assertClientScope, type ClientScope, type ClientTargetParams, clientScope } from "../client-params.ts";
import { createPiClient, type PiClientRuntime } from "./create-client.ts";

export interface ObtainClientForCreateParams {
    readonly scope: ClientScope;
    readonly callbacks: PiAcpClient;
    readonly signal: AbortSignal;
}

type OwnedClient = { readonly client: PiAcpAgent; readonly scope: ClientScope } & (
    | { readonly kind: "ready" }
    | { readonly kind: "closing"; readonly completion: Promise<void> }
);

export interface PiClientReservation {
    readonly kind: "existing" | "new";
    readonly nativeSessionId: NativeSessionId;
    readonly scope: ClientScope;
}

/** Owns retained Pi clients, never native session operations or global capacity policy. */
export class PiClientManager {
    #runtime: PiClientRuntime;
    readonly #operations = new RuntimeOperations();
    readonly #unbound = new WeakMap<PiAcpAgent, ClientScope>();
    readonly #clients = new Map<NativeSessionId, OwnedClient>();
    readonly #reservations = new Map<NativeSessionId, PiClientReservation>();
    readonly #processes: AgentProcessPool;
    readonly #queries: RetainedAgentProcesses<PiAcpAgent>;
    readonly #queryKeys = new WeakMap<PiAcpAgent, string>();

    constructor(runtime: PiClientRuntime, processes: AgentProcessPool) {
        this.#runtime = runtime;
        this.#processes = processes;
        this.#queries = new RetainedAgentProcesses<PiAcpAgent>({
            touch: processes.touch,
            changed: processes.notifyChanged,
        });
    }

    readonly refreshRuntime = (runtime: PiClientRuntime): void => {
        this.#runtime = runtime;
    };

    readonly obtainClientForCreate = async (params: ObtainClientForCreateParams): Promise<PiAcpAgent> => {
        const scope = clientScope(params.scope);
        const runtime = this.#runtime;
        const client = await this.#operations.run(
            { ...params, signal: AbortSignal.any([params.signal, AbortSignal.timeout(60_000)]) },
            ({ signal }) => createPiClient(runtime, params.callbacks, signal),
            (client) => client.dispose(),
        );
        this.#unbound.set(client, scope);
        return client;
    };

    readonly obtainClientForOpen = async (params: ClientTargetParams): Promise<PiAcpAgent> => {
        this.#operations.signal.throwIfAborted();
        params.signal.throwIfAborted();
        const entry = this.#clients.get(nativeSessionIdSchema.parse(params.nativeSessionId));
        if (entry === undefined) {
            throw new AcpExecutionError("The native session is not active", {}, "invalid_agent_session");
        }
        assertClientScope(entry.scope, params);
        if (entry.kind !== "ready" || entry.client.signal.aborted) {
            throw new AcpExecutionError("The Pi client is unavailable", {}, "session_busy");
        }
        return entry.client;
    };

    /** Reserve identity before resume/replay, including when reusing an existing client. */
    readonly reserveSession = (params: ClientTargetParams): PiClientReservation => {
        this.#operations.signal.throwIfAborted();
        params.signal.throwIfAborted();
        const scope = clientScope(params);
        const nativeSessionId = nativeSessionIdSchema.parse(params.nativeSessionId);
        if (this.#reservations.has(nativeSessionId)) {
            throw new AcpExecutionError("Another writer is opening this native session", {}, "session_busy");
        }
        const entry = this.#clients.get(nativeSessionId);
        if (entry !== undefined) {
            assertClientScope(entry.scope, params);
        }
        const reservation: PiClientReservation = {
            kind: entry === undefined ? "new" : "existing",
            nativeSessionId,
            scope,
        };
        this.#reservations.set(nativeSessionId, reservation);
        return reservation;
    };

    readonly releaseReservation = (reservation: PiClientReservation): void => {
        if (this.#reservations.get(reservation.nativeSessionId) === reservation) {
            this.#reservations.delete(reservation.nativeSessionId);
        }
    };

    readonly adoptClient = (params: {
        readonly client: PiAcpAgent;
        readonly nativeSessionId: NativeSessionId;
        readonly signal: AbortSignal;
        readonly reservation?: PiClientReservation;
    }): void => {
        this.#operations.signal.throwIfAborted();
        params.signal.throwIfAborted();
        params.client.signal.throwIfAborted();
        const nativeSessionId = nativeSessionIdSchema.parse(params.nativeSessionId);
        const reservation = this.#reservations.get(nativeSessionId);
        if (this.#clients.has(nativeSessionId) || reservation !== params.reservation) {
            throw new AcpExecutionError("Another writer is using this native session", {}, "session_busy");
        }
        const scope = this.#unbound.get(params.client);
        if (scope === undefined) {
            throw new AcpExecutionError("The Pi client cannot be adopted", {}, "invalid_agent_session");
        }
        if (reservation !== undefined) {
            assertClientScope(reservation.scope, scope);
        }
        this.#clients.set(nativeSessionId, { kind: "ready", client: params.client, scope });
        this.#unbound.delete(params.client);
    };

    readonly obtainClientForQuery = async (params: ObtainClientForCreateParams): Promise<PiAcpAgent> => {
        this.#operations.signal.throwIfAborted();
        params.signal.throwIfAborted();
        const scope = clientScope(params.scope);
        const runtime = this.#runtime;
        const key = JSON.stringify([
            runtime.command,
            runtime.runtimeExecutables,
            Object.entries(runtime.environment).sort(),
            scope.cwd,
            scope.additionalDirectories,
        ]);
        const processes = this.#processes;
        this.#queries.borrow(key);
        try {
            const current = this.#queries.get(key);
            if (current !== undefined && !current.signal.aborted) {
                return current;
            }
            const pending = this.#queries.prepare(key, () =>
                this.#operations.run(
                    { signal: AbortSignal.timeout(60_000) },
                    async ({ signal }) => {
                        if (current !== undefined) {
                            await this.#retireQuery(key, current);
                        }
                        const retire = (client: PiAcpAgent) => this.#retireQuery(key, client);
                        const client = await processes.startRetained(
                            signal,
                            () => createPiClient(runtime, params.callbacks, signal),
                            { isBusy: () => this.#queries.isBusy(key), retire, retireIdle: retire },
                        );
                        if (signal.aborted) {
                            await retire(client);
                            signal.throwIfAborted();
                        }
                        this.#queryKeys.set(client, key);
                        this.#queries.retain(key, client);
                        return client;
                    },
                    (client) => this.#retireQuery(key, client),
                ),
            );
            const client = await waitForSharedOperation(pending, params.signal);
            params.signal.throwIfAborted();
            return client;
        } catch (cause) {
            this.#queries.release(key);
            throw cause;
        }
    };

    readonly releaseQueryClient = (client: PiAcpAgent): void => {
        const key = this.#queryKeys.get(client);
        if (key !== undefined) {
            this.#queries.release(key);
        }
    };

    readonly #retireQuery = async (key: string, client: PiAcpAgent): Promise<void> => {
        this.#queries.detach(key, client);
        await this.#processes.retire(client, () => client.dispose());
    };

    readonly release = async (params: ClientTargetParams): Promise<void> => {
        const nativeSessionId = nativeSessionIdSchema.parse(params.nativeSessionId);
        clientScope(params);
        const entry = this.#clients.get(nativeSessionId);
        if (entry !== undefined) {
            assertClientScope(entry.scope, params);
            const completion =
                entry.kind === "closing" ? entry.completion : Promise.resolve().then(() => entry.client.dispose());
            this.#clients.set(nativeSessionId, { ...entry, kind: "closing", completion });
            await completion;
            this.#clients.delete(nativeSessionId);
        }
        params.signal.throwIfAborted();
    };

    readonly close = (): Promise<void> =>
        this.#operations.close(async () => {
            const results = await Promise.allSettled([
                ...[...this.#clients].map(([nativeSessionId, entry]) =>
                    this.release({ ...entry.scope, nativeSessionId, signal: new AbortController().signal }),
                ),
                ...this.#queries.entries().map(([key, client]) => this.#retireQuery(key, client)),
            ]);
            this.#reservations.clear();
            const failures = results.filter((result) => result.status === "rejected");
            if (failures.length > 0) {
                throw new AcpExecutionError("Pi clients could not be released", {
                    cause: new AggregateError(failures.map((failure) => failure.reason)),
                });
            }
        });
}
