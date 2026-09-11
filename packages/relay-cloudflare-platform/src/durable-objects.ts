import {
    BotConnectionActor as BotConnectionImplementation,
    createDurableObjectContext,
    type LiteSessionConfigurationEnvironment,
    RuntimeRelay as RuntimeRelayImplementation,
    SessionRelay as SessionRelayImplementation,
} from "@moxt-ai/mobius-relay-core";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import { PlatformBucketResolver } from "./storage/platform-bucket-resolver.ts";
import { PlatformControlPlaneStorage } from "./storage/platform-control-plane-storage.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
    platformDatabaseBindings,
} from "./storage/platform-database-resolver.ts";

interface PlatformDurableObjectEnvironment extends LiteSessionConfigurationEnvironment, PlatformStorageBindings {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly D1_SHARD_APAC_01: D1Database;
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

function createContext(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
    const databaseBindings = platformDatabaseBindings(environment);
    const databases = new PlatformDatabaseResolver(environment);
    const controlStorage = new PlatformControlPlaneStorage(
        environment.PLATFORM_DIRECTORY_DATABASE,
        databaseBindings.map(({ database }) => database),
    );
    const registry = new PlatformStorageRegistry(environment);
    const projects = new PlatformProjectStorageDirectory(
        { read: controlStorage.readProjectStoragePlacement },
        registry,
    );
    return createDurableObjectContext(state, {
        environment,
        connections: environment.BOT_CONNECTIONS,
        sessions: environment.SESSION_RELAY,
        namespacePrefix: "platform",
        databases,
        projects,
        content: { kind: "r2", buckets: new PlatformBucketResolver(environment) },
    });
}

export class RuntimeRelay extends RuntimeRelayImplementation {
    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(createContext(state, environment));
    }
}

export class BotConnectionActor extends BotConnectionImplementation {
    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(createContext(state, environment));
    }
}

export class PlatformSessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(createContext(state, environment));
    }
}
