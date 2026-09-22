import { DurableObject } from "cloudflare:workers";
import {
    applyDurableObjectMigrations,
    type DoSqlDatabase,
    DurableObjectSqlDatabase,
    type SessionEventReceiver,
    SessionRelay as SessionRelayImplementation,
    SessionRuntimeError,
} from "@moxt-ai/mobius-relay-core";
import { Hono } from "hono";
import { PlatformSessionLiveHistoryClient } from "../gateway/platform-session-live-history-client.ts";
import { nonCloudRetentionSessionRelayDurableObjectMigrations } from "../generated/non-cloud-retention-session-relay-do-migrations.ts";
import {
    createPlatformDurableObjectContext,
    type PlatformDurableObjectEnvironment,
} from "./platform-durable-object-context.ts";

const HIBERNATION_DELAY_MILLISECONDS = 5 * 60_000;
const HIBERNATION_DEADLINE_KEY = "non-cloud-retention-hibernation-at";

export class NonCloudRetentionSessionRelayDO extends DurableObject<PlatformDurableObjectEnvironment> {
    readonly #environment: PlatformDurableObjectEnvironment;
    #lifecycle:
        | { readonly kind: "active" }
        | { readonly kind: "hibernating"; readonly completion: PromiseWithResolvers<void> } = { kind: "active" };
    readonly #sessions = new Map<string, Promise<{ readonly relay: SessionRelayImplementation }>>();
    readonly #liveEventSubscriptions = new Map<
        string,
        {
            readonly finish: () => void;
            readonly relay: SessionRelayImplementation;
            readonly relaySubscriptionId: string;
        }
    >();
    readonly #operations = new Map<string, Promise<void>>();
    readonly #routes: Hono;
    readonly #liveHistory: PlatformSessionLiveHistoryClient;
    readonly #state: DurableObjectState;

    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(state, environment);
        this.#environment = environment;
        this.#liveHistory = new PlatformSessionLiveHistoryClient(environment);
        this.#state = state;
        this.#routes = new Hono().all(
            "/internal/projects/:projectId/runtimes/:runtimeId/sessions/:sessionId/:operation",
            (context) =>
                this.handleRequest(context.req.raw, {
                    projectId: context.req.param("projectId"),
                    runtimeId: context.req.param("runtimeId"),
                    sessionId: context.req.param("sessionId"),
                    operation: context.req.param("operation"),
                }),
        );
    }

    override readonly fetch = async (request: Request): Promise<Response> => await this.#routes.fetch(request);

    async subscribeToLiveSessionEvents(
        subscriptionId: string,
        projectId: string,
        runtimeId: string,
        sessionId: string,
        receive: SessionEventReceiver,
    ): Promise<void> {
        const { relay } = await this.session({ projectId, runtimeId, sessionId }, false, AbortSignal.timeout(20_000));
        const relaySubscriptionId = await relay.subscribeToLiveSessionEvents(projectId, sessionId, receive);
        await new Promise<void>((finish) => {
            this.#liveEventSubscriptions.set(subscriptionId, { finish, relay, relaySubscriptionId });
        });
    }

    unsubscribeFromLiveSessionEvents(subscriptionId: string): void {
        const subscription = this.#liveEventSubscriptions.get(subscriptionId);
        this.#liveEventSubscriptions.delete(subscriptionId);
        subscription?.relay.unsubscribeFromLiveSessionEvents(subscription.relaySubscriptionId);
        subscription?.finish();
    }

    private readonly handleRequest = async (request: Request, route: SessionRequestRoute): Promise<Response> => {
        const identity = sessionRequestIdentity(route);
        const relayEndpoint = new URL(request.url);
        relayEndpoint.pathname = `/internal/sessions/${route.operation}`;
        const relayRequest = new Request(relayEndpoint, request);
        if (this.#lifecycle.kind === "hibernating") {
            await waitForCompletion(this.#lifecycle.completion.promise, request.signal);
        }
        if (route.operation === "query-native-messages") {
            try {
                const page = await queryNativeMessagesRequest(request, identity.projectId, identity.sessionId);
                const restored = await this.#liveHistory.restorePage(
                    identity.projectId,
                    identity.runtimeId,
                    identity.sessionId,
                    page,
                    request.signal,
                );
                return Response.json(restored);
            } catch (cause) {
                if (cause instanceof SessionRuntimeError) {
                    const error = cause.toHttpJson();
                    return Response.json(error.body, { status: error.status });
                }
                throw cause;
            }
        }
        if (route.operation === "native-history") {
            const restored = await this.#liveHistory.restore(
                identity.projectId,
                identity.runtimeId,
                identity.sessionId,
                request.signal,
            );
            return Response.json(restored.history);
        }
        const previous = this.#operations.get(identity.sessionId) ?? Promise.resolve();
        const operation = previous
            .catch(() => {})
            .then(async () => {
                try {
                    const session = await this.session(
                        identity,
                        route.operation === "create" ||
                            route.operation === "import" ||
                            route.operation === "bot-provision",
                        request.signal,
                    );
                    return await session.relay.fetch(relayRequest);
                } finally {
                    await this.armHibernation();
                }
            });
        this.#operations.set(
            identity.sessionId,
            operation.then(
                () => {},
                () => {},
            ),
        );
        return await operation;
    };

    override readonly alarm = async (): Promise<void> => {
        if (this.#lifecycle.kind === "hibernating") {
            await this.#lifecycle.completion.promise;
            return;
        }
        const completion = Promise.withResolvers<void>();
        this.#lifecycle = { kind: "hibernating", completion };
        const failures: unknown[] = [];
        let hibernationAt = Date.now() + HIBERNATION_DELAY_MILLISECONDS;
        try {
            const storedHibernationAt: unknown = await this.#state.storage.get(HIBERNATION_DEADLINE_KEY);
            if (typeof storedHibernationAt === "number" && Number.isSafeInteger(storedHibernationAt)) {
                hibernationAt = storedHibernationAt;
            }
            for (const result of await Promise.allSettled(this.#operations.values())) {
                if (result.status === "rejected") {
                    failures.push(result.reason);
                }
            }
            for (const pending of this.#sessions.values()) {
                let session: Awaited<typeof pending>;
                try {
                    session = await pending;
                } catch (cause) {
                    failures.push(cause);
                    continue;
                }
                try {
                    await session.relay.alarm();
                } catch (cause) {
                    failures.push(cause);
                }
            }
            if (Date.now() >= hibernationAt && failures.length === 0) {
                this.#sessions.clear();
                this.#operations.clear();
                try {
                    this.createRelay(new DurableObjectSqlDatabase(this.#state.storage)).scrubNonRetainedContent();
                    await this.#state.storage.delete(HIBERNATION_DEADLINE_KEY);
                    await this.#state.storage.deleteAlarm();
                } catch (cause) {
                    failures.push(cause);
                }
            } else if (failures.length === 0) {
                try {
                    const scheduled = await this.#state.storage.getAlarm();
                    if (scheduled === null || scheduled > hibernationAt) {
                        await this.#state.storage.setAlarm(hibernationAt);
                    }
                } catch (cause) {
                    failures.push(cause);
                }
            }
        } finally {
            this.#lifecycle = { kind: "active" };
            completion.resolve();
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "The non-cloud-retention Session relay could not hibernate");
        }
    };

    private readonly createRelay = (database: DurableObjectSqlDatabase): SessionRelayImplementation =>
        new SessionRelayImplementation(
            createPlatformDurableObjectContext(this.#state, this.#environment, {
                content: { kind: "sqlite" },
                database,
                initializeSessionSchema: initializeNonCloudRetentionSessionRelaySchema,
            }),
        );

    private readonly session = async (
        identity: SessionRequestIdentity,
        creating: boolean,
        signal: AbortSignal,
    ): Promise<{ readonly relay: SessionRelayImplementation }> => {
        const existing = this.#sessions.get(identity.sessionId);
        if (existing !== undefined) {
            return await existing;
        }
        const created = (async () => {
            const database = new DurableObjectSqlDatabase(this.#state.storage);
            const relay = this.createRelay(database);
            const persisted =
                database.query(
                    `SELECT 1 AS present
                     FROM sessions
                     WHERE project_id = ? AND runtime_id = ? AND session_id = ? AND lifecycle = 'ready'
                     LIMIT 1`,
                    [identity.projectId, identity.runtimeId, identity.sessionId],
                ).length > 0;
            if (!creating && !persisted) {
                const restored = await this.#liveHistory.restore(
                    identity.projectId,
                    identity.runtimeId,
                    identity.sessionId,
                    signal,
                );
                await requireSuccessfulRelayResponse(
                    relay,
                    "create",
                    {
                        cloudRetention: false,
                        now: restored.createdAt,
                        request: restored.request,
                        scope: { projectId: identity.projectId },
                    },
                    signal,
                );
                await requireSuccessfulRelayResponse(
                    relay,
                    "record-native-history",
                    {
                        history: restored.history,
                        now: Date.now(),
                        runtimeId: identity.runtimeId,
                        sessionId: identity.sessionId,
                        scope: { projectId: identity.projectId },
                        title: "",
                    },
                    signal,
                );
            }
            return { relay };
        })();
        this.#sessions.set(identity.sessionId, created);
        try {
            return await created;
        } catch (cause) {
            this.#sessions.delete(identity.sessionId);
            throw cause;
        }
    };

    private readonly armHibernation = async (): Promise<void> => {
        const hibernationAt = Date.now() + HIBERNATION_DELAY_MILLISECONDS;
        await this.#state.storage.put(HIBERNATION_DEADLINE_KEY, hibernationAt);
        const scheduled = await this.#state.storage.getAlarm();
        if (scheduled === null || scheduled > hibernationAt) {
            await this.#state.storage.setAlarm(hibernationAt);
        }
    };
}

async function queryNativeMessagesRequest(
    request: Request,
    expectedProjectId: string,
    expectedSessionId: string,
): Promise<{ readonly cursor: string | null; readonly limit: number }> {
    let value: unknown;
    try {
        value = await request.json();
    } catch (cause) {
        throw new SessionRuntimeError("invalid_request", "The native Session history request is invalid", { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new SessionRuntimeError("invalid_request", "The native Session history request is invalid");
    }
    const requestValue = Object.fromEntries(Object.entries(value));
    const cursor = requestValue["cursor"];
    const limit = requestValue["limit"];
    const scope = requestValue["scope"];
    if (
        Object.keys(requestValue).sort().join(",") !== "cursor,limit,scope,sessionId" ||
        requestValue["sessionId"] !== expectedSessionId ||
        typeof scope !== "object" ||
        scope === null ||
        Array.isArray(scope) ||
        Object.keys(scope).length !== 1 ||
        Object.entries(scope)[0]?.[0] !== "projectId" ||
        Object.entries(scope)[0]?.[1] !== expectedProjectId ||
        (cursor !== null && (typeof cursor !== "string" || cursor.length > 512)) ||
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
    ) {
        throw new SessionRuntimeError("invalid_request", "The native Session history request is invalid");
    }
    return { cursor, limit };
}

function initializeNonCloudRetentionSessionRelaySchema(database: DoSqlDatabase): void {
    applyDurableObjectMigrations(
        database,
        "non-cloud-retention-session-relay-do",
        nonCloudRetentionSessionRelayDurableObjectMigrations,
    );
}

async function requireSuccessfulRelayResponse(
    relay: SessionRelayImplementation,
    operation: string,
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
): Promise<void> {
    const response = await relay.fetch(
        new Request(`https://session.internal/internal/sessions/${operation}`, {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal,
        }),
    );
    if (!response.ok) {
        throw new Error("The live Session history could not be restored");
    }
}

interface SessionRequestIdentity {
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

interface SessionRequestRoute {
    readonly operation: string;
    readonly projectId: string;
    readonly runtimeId: string;
    readonly sessionId: string;
}

function identifier(value: unknown): string | null {
    return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : null;
}

async function waitForCompletion(completion: Promise<void>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let stop = () => {};
    try {
        await Promise.race([
            completion,
            new Promise<void>((_resolve, reject) => {
                const aborted = () => reject(signal.reason);
                stop = () => signal.removeEventListener("abort", aborted);
                signal.addEventListener("abort", aborted, { once: true });
            }),
        ]);
    } finally {
        stop();
    }
}

function sessionRequestIdentity(route: SessionRequestRoute): SessionRequestIdentity {
    const operation = identifier(route.operation);
    const projectId = identifier(route.projectId);
    const runtimeId = identifier(route.runtimeId);
    const sessionId = identifier(route.sessionId);
    if (operation === null || projectId === null || runtimeId === null || sessionId === null) {
        throw new Error("The non-cloud-retention Session request identity is invalid");
    }
    return { projectId, runtimeId, sessionId };
}
