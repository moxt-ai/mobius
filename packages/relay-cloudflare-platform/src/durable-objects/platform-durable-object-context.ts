import {
    CloudflareSessionTransport,
    createDurableObjectContext,
    type DoSqlDatabase,
    type DurableObjectSqlDatabase,
    type LiteSessionConfigurationEnvironment,
} from "@moxt-ai/mobius-relay-core";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";
import { PlatformProjectStorageDirectory } from "../infra/platform-project-storage-directory.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
} from "../storage/platform-database-resolver.ts";

export interface PlatformDurableObjectEnvironment extends LiteSessionConfigurationEnvironment, PlatformStorageBindings {
    readonly RUNTIME_RELAY: DurableObjectNamespace;
}

export function createPlatformDurableObjectContext(
    state: DurableObjectState,
    environment: PlatformDurableObjectEnvironment,
    storage:
        | {
              readonly database: DurableObjectSqlDatabase;
          }
        | {
              readonly database: DurableObjectSqlDatabase;
              readonly initializeSessionSchema?: (database: DoSqlDatabase) => void;
          },
) {
    const databases = new PlatformDatabaseResolver(environment);
    const registry = new PlatformStorageRegistry(environment);
    const projects = new PlatformProjectStorageDirectory(registry);
    return createDurableObjectContext(state, {
        environment,
        runtimeRelay: environment.RUNTIME_RELAY,
        sessionTransport: new CloudflareSessionTransport(
            environment.RUNTIME_RELAY,
            (projectId) => decodePlatformProjectPlacement(projectId)?.locationHint,
        ),
        databases,
        projects,
        doDatabase: storage.database,
        ...("initializeSessionSchema" in storage && storage.initializeSessionSchema !== undefined
            ? { initializeSessionSchema: storage.initializeSessionSchema }
            : {}),
    });
}
