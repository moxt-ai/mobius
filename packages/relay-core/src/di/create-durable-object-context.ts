import { CloudflareChannelPeers } from "../gateway/cloudflare-channel-peers.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { DurableObjectSqlDatabase } from "../infra/durable-object-sql-database.ts";
import type { ProjectDatabaseBindings } from "../infra/project-database-bindings.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly databases: ProjectDatabaseBindings;
        readonly projects: ProjectStorageDirectory;
        readonly doDatabase?: DoSqlDatabase;
    },
) {
    return createDurableObjectDependencies({
        doDatabase: options.doDatabase ?? new DurableObjectSqlDatabase(state.storage),
        storages: {
            databaseResolver: options.databases,
            projectDirectory: options.projects,
        },
        gateways: {
            peers: new CloudflareChannelPeers(state),
        },
        utilities: {
            waitUntil: (operation) => state.waitUntil(operation),
        },
    });
}
