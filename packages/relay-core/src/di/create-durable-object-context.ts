import { CloudflareChannelPeers } from "../gateway/cloudflare-channel-peers.ts";
import { CloudflareSessionTransport } from "../gateway/cloudflare-session-transport.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import type { BucketResolver } from "../infra/bucket-resolver.ts";
import { DurableObjectSqlDatabase } from "../infra/durable-object-sql-database.ts";
import type { ProjectDatabaseBindings } from "../infra/project-database-bindings.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import {
    type LiteSessionConfigurationEnvironment,
    sessionArchiveByteLimitFromEnvironment,
    sessionQuotaFromEnvironment,
} from "../infra/session-configuration.ts";
import { R2ContentStore } from "../storage/r2-content-store.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly environment: LiteSessionConfigurationEnvironment;
        readonly sessions: DurableObjectNamespace;
        readonly namespacePrefix: string;
        readonly databases: ProjectDatabaseBindings;
        readonly projects: ProjectStorageDirectory;
        readonly content: { readonly kind: "sqlite" } | { readonly kind: "r2"; readonly buckets: BucketResolver };
        readonly sessionTransport?: SessionTransport;
    },
) {
    return createDurableObjectDependencies({
        doDatabase: new DurableObjectSqlDatabase(state.storage),
        quota: sessionQuotaFromEnvironment(options.environment),
        content:
            options.content.kind === "sqlite"
                ? { kind: "sqlite", archiveByteLimit: sessionArchiveByteLimitFromEnvironment(options.environment) }
                : { kind: "external", content: new R2ContentStore(options.content.buckets, options.projects) },
        gateways: {
            databaseResolver: options.databases,
            projectStorageDirectory: options.projects,
            sessionTransport:
                options.sessionTransport ?? new CloudflareSessionTransport(options.sessions, options.namespacePrefix),
            peers: new CloudflareChannelPeers(state),
            schedule: async (timestamp, signal) => {
                signal.throwIfAborted();
                await state.storage.setAlarm(timestamp);
                signal.throwIfAborted();
            },
        },
    });
}
