import { CloudflareChannelPeers } from "../gateway/cloudflare-channel-peers.ts";
import { CloudflareSessionTransport } from "../gateway/cloudflare-session-transport.ts";
import type { SessionTransport } from "../gateway/session-transport.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { DurableObjectSqlDatabase } from "../infra/durable-object-sql-database.ts";
import type { ProjectDatabaseBindings } from "../infra/project-database-bindings.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import {
    type LiteSessionConfigurationEnvironment,
    sessionQuotaFromEnvironment,
} from "../infra/session-configuration.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly environment: LiteSessionConfigurationEnvironment;
        readonly runtimeRelay: DurableObjectNamespace;
        readonly databases: ProjectDatabaseBindings;
        readonly projects: ProjectStorageDirectory;
        readonly sessionTransport?: SessionTransport;
        readonly doDatabase?: DoSqlDatabase;
        readonly initializeSessionSchema?: (database: DoSqlDatabase) => void;
    },
) {
    return createDurableObjectDependencies({
        doDatabase: options.doDatabase ?? new DurableObjectSqlDatabase(state.storage),
        ...(options.initializeSessionSchema === undefined
            ? {}
            : { initializeSessionSchema: options.initializeSessionSchema }),
        quota: sessionQuotaFromEnvironment(options.environment),
        storages: {
            databaseResolver: options.databases,
            projectDirectory: options.projects,
        },
        gateways: {
            sessionTransport: options.sessionTransport ?? new CloudflareSessionTransport(options.runtimeRelay),
            peers: new CloudflareChannelPeers(state),
        },
        utilities: {
            schedule: async (timestamp, signal) => {
                signal.throwIfAborted();
                await state.storage.setAlarm(timestamp);
                signal.throwIfAborted();
            },
            waitUntil: (operation) => state.waitUntil(operation),
        },
    });
}
