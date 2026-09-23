import { createDurableObjectContext, type DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import { PlatformProjectStorageDirectory } from "../infra/platform-project-storage-directory.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
} from "../storage/platform-database-resolver.ts";

export interface PlatformDurableObjectEnvironment extends PlatformStorageBindings {
    readonly RUNTIME_RELAY: DurableObjectNamespace;
}

export function createPlatformDurableObjectContext(
    state: DurableObjectState,
    environment: PlatformDurableObjectEnvironment,
    storage: { readonly database: DurableObjectSqlDatabase },
) {
    const databases = new PlatformDatabaseResolver(environment);
    const registry = new PlatformStorageRegistry(environment);
    const projects = new PlatformProjectStorageDirectory(registry);
    return createDurableObjectContext(state, {
        databases,
        projects,
        doDatabase: storage.database,
    });
}
