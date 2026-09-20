import {
    CloudflareSessionTransport,
    createDurableObjectContext,
    type DoSqlDatabase,
    type DurableObjectSqlDatabase,
    type LiteSessionConfigurationEnvironment,
} from "@moxt-ai/mobius-relay-core";
import { decodePlatformProjectPlacement } from "../entity/platform-project-id.ts";
import { PlatformProjectStorageDirectory } from "../infra/platform-project-storage-directory.ts";
import type { PlatformBucketResolver } from "../storage/platform-bucket-resolver.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
} from "../storage/platform-database-resolver.ts";

export interface PlatformDurableObjectEnvironment extends LiteSessionConfigurationEnvironment, PlatformStorageBindings {
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly NON_CLOUD_RETENTION_SESSION_RELAY: DurableObjectNamespace;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

export function createPlatformDurableObjectContext(
    state: DurableObjectState,
    environment: PlatformDurableObjectEnvironment,
    storage:
        | {
              readonly database: DurableObjectSqlDatabase;
              readonly content: { readonly kind: "r2"; readonly buckets: PlatformBucketResolver };
          }
        | {
              readonly database: DurableObjectSqlDatabase;
              readonly content: { readonly kind: "sqlite" };
              readonly initializeSessionSchema?: (database: DoSqlDatabase) => void;
          },
) {
    const databases = new PlatformDatabaseResolver(environment);
    const registry = new PlatformStorageRegistry(environment);
    const projects = new PlatformProjectStorageDirectory(registry);
    return createDurableObjectContext(state, {
        environment,
        sessions: environment.SESSION_RELAY,
        namespacePrefix: "platform",
        sessionTransport: new CloudflareSessionTransport(
            environment.SESSION_RELAY,
            "platform",
            (projectId) => decodePlatformProjectPlacement(projectId)?.locationHint,
            environment.NON_CLOUD_RETENTION_SESSION_RELAY,
        ),
        databases,
        projects,
        content: storage.content,
        doDatabase: storage.database,
        ...("initializeSessionSchema" in storage && storage.initializeSessionSchema !== undefined
            ? { initializeSessionSchema: storage.initializeSessionSchema }
            : {}),
    });
}
