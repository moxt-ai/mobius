import {
    CloudflareSessionTransport,
    createDurableObjectContext,
    type LiteSessionConfigurationEnvironment,
    RuntimeRelay as RuntimeRelayImplementation,
    SessionRelay as SessionRelayImplementation,
} from "@moxt-ai/mobius-relay-core";
import { decodePlatformProjectPlacement } from "./entity/platform-project-id.ts";
import { PlatformProjectStorageDirectory } from "./infra/platform-project-storage-directory.ts";
import { PlatformBucketResolver } from "./storage/platform-bucket-resolver.ts";
import {
    PlatformDatabaseResolver,
    type PlatformStorageBindings,
    PlatformStorageRegistry,
} from "./storage/platform-database-resolver.ts";

interface PlatformDurableObjectEnvironment extends LiteSessionConfigurationEnvironment, PlatformStorageBindings {
    readonly R2_BUCKET_APAC: R2Bucket;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

function createContext(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
    const databases = new PlatformDatabaseResolver(environment);
    const registry = new PlatformStorageRegistry(environment);
    const projects = new PlatformProjectStorageDirectory(registry);
    return createDurableObjectContext(state, {
        environment,
        sessions: environment.SESSION_RELAY,
        sessionTransport: new CloudflareSessionTransport(
            environment.SESSION_RELAY,
            "platform",
            (projectId) => decodePlatformProjectPlacement(projectId)?.locationHint,
        ),
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

export class PlatformSessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(createContext(state, environment));
    }
}
