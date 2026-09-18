import {
    createDurableObjectDependencies,
    type DurableObjectContext,
} from "../../packages/relay-core/src/di/create-durable-object-dependencies.ts";
import type { WorkerRuntimeGateways } from "../../packages/relay-core/src/di/create-worker-context.ts";
import { DEFAULT_SESSION_QUOTA_POLICY, ProjectScope } from "../../packages/relay-core/src/entity/do/session.ts";
import type { DatabaseResolver } from "../../packages/relay-core/src/infra/database-resolver.ts";
import type { ProjectStorageDirectory } from "../../packages/relay-core/src/infra/project-storage-directory.ts";
import { RuntimeStatus } from "../../packages/relay-core/src/service/channel/channel.ts";
import { TestRuntimePeers } from "./peers.ts";
import { TestSqliteDatabase } from "./sqlite.ts";

/** Local hosting adapter: production actor logic on SQLite, sharing the caller's clock. */
export function createTestGateways(options: {
    readonly databases: DatabaseResolver;
    readonly projects: ProjectStorageDirectory;
    readonly signal: AbortSignal;
}) {
    const databases = new AsyncDisposableStack();
    const connections = new AsyncDisposableStack();
    const actors = new Map<string, DurableObjectContext>();
    const alarms = new Map<string, number>();
    function actor(key: string): DurableObjectContext {
        const existing = actors.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const database = databases.use(new TestSqliteDatabase());
        const peers = connections.use(new TestRuntimePeers(() => context.services.runtime, options.signal));
        const context = createDurableObjectDependencies({
            doDatabase: database,
            quota: DEFAULT_SESSION_QUOTA_POLICY,
            content: { kind: "sqlite", archiveByteLimit: 100_000_000 },
            gateways: {
                databaseResolver: options.databases,
                projectStorageDirectory: options.projects,
                peers,
                sessionTransport: gateways.sessions,
                schedule: async (timestamp, signal) => {
                    signal.throwIfAborted();
                    alarms.set(key, timestamp);
                },
            },
        });
        actors.set(key, context);
        return context;
    }
    const gateways: WorkerRuntimeGateways = {
        sessions: {
            fetch: async (scope, sessionId, request) =>
                await actor(`session:${scope.projectId}:${sessionId}`).applications.session.request(request),
        },
        channel: {
            acceptDaemon: async (access, request, signal) => {
                const url = new URL(request.url);
                url.pathname = `/projects/${encodeURIComponent(access.projectId)}/daemon`;
                const headers = new Headers(request.headers);
                headers.set("x-mobius-channel-id", access.channelId);
                headers.set("x-mobius-runtime-id", access.runtimeId);
                return await actor(`runtime:${access.channelId}`).applications.runtime.request(
                    new Request(url, { headers, signal }),
                );
            },
            acceptHost: async (access, request, signal) => {
                const url = new URL(request.url);
                url.pathname = `/projects/${encodeURIComponent(access.projectId)}${url.pathname}`;
                const headers = new Headers(request.headers);
                headers.set("x-mobius-channel-id", access.channelId);
                headers.set("x-mobius-runtime-id", access.runtimeId);
                headers.set("x-mobius-host-credential-id", access.credentialId);
                return await actor(`runtime:${access.channelId}`).applications.runtime.request(
                    new Request(url, { headers, signal }),
                );
            },
            disconnectHost: async (access, signal) => {
                signal.throwIfAborted();
                actor(`runtime:${access.channelId}`).services.runtime.revokeHost(
                    access.channelId,
                    access.credentialId,
                    access.runtimeId,
                    new ProjectScope(access.projectId),
                );
            },
            disconnectRuntime: async (access, signal) =>
                await actor(`runtime:${access.channelId}`).services.runtime.revokeRuntime(
                    access.channelId,
                    access.runtimeId,
                    new ProjectScope(access.projectId),
                    signal,
                ),
            dispatchPending: async (access, signal) =>
                await actor(`runtime:${access.channelId}`).services.runtime.dispatchPending(
                    access.runtimeId,
                    new ProjectScope(access.projectId),
                    signal,
                ),
            readRuntimeStatus: async (access, signal) => {
                signal.throwIfAborted();
                return new RuntimeStatus(
                    actor(`runtime:${access.channelId}`).services.runtime.isOnline(access.runtimeId),
                );
            },
        },
    };
    return {
        ...gateways,
        runAlarms: async () => {
            for (const [key, deadline] of alarms) {
                if (deadline > Date.now()) {
                    continue;
                }
                alarms.delete(key);
                const context = actor(key);
                if (key.startsWith("runtime:")) {
                    await context.services.runtime.alarm(options.signal);
                } else {
                    await context.services.sessionRecovery.recover(options.signal);
                }
            }
        },
        [Symbol.asyncDispose]: async () => {
            // Runtime disconnects can still write to Session actors during teardown.
            try {
                await connections.disposeAsync();
            } finally {
                await databases.disposeAsync();
            }
        },
    };
}
