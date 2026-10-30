import { CloudflareChannelPeers } from "../gateway/cloudflare-channel-peers.ts";
import type { DoSqlDatabase } from "../infra/do-sql-database.ts";
import { DurableObjectSqlDatabase } from "../infra/durable-object-sql-database.ts";
import type { ProjectStorageDirectory } from "../infra/project-storage-directory.ts";
import type { ProjectStoreResolver } from "../infra/project-store.ts";
import type { SessionRecording } from "../infra/session-recording.ts";
import type { SessionStatusNotifications } from "../infra/session-status-notifications.ts";
import { createDurableObjectDependencies } from "./create-durable-object-dependencies.ts";

export function createDurableObjectContext(
    state: DurableObjectState,
    options: {
        readonly stores: ProjectStoreResolver;
        readonly projects: ProjectStorageDirectory;
        readonly doDatabase?: DoSqlDatabase;
        readonly recording?: SessionRecording;
        readonly notifications?: SessionStatusNotifications;
    },
) {
    return createDurableObjectDependencies({
        doDatabase: options.doDatabase ?? new DurableObjectSqlDatabase(state.storage),
        storages: {
            projectStores: options.stores,
            projectDirectory: options.projects,
        },
        gateways: {
            peers: new CloudflareChannelPeers(state),
            ...(options.recording === undefined ? {} : { recording: options.recording }),
            ...(options.notifications === undefined ? {} : { notifications: options.notifications }),
        },
        utilities: {
            waitUntil: (operation) => state.waitUntil(operation),
        },
    });
}
