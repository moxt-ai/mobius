import {
    createDurableObjectContext,
    type LiteSessionConfigurationEnvironment,
    RuntimeRelay as RuntimeRelayImplementation,
    SessionRelay as SessionRelayImplementation,
} from "@moxt-ai/mobius-relay-core";
import { SingleBucketResolver } from "./bucket-resolver.ts";
import { SingleDatabaseResolver } from "./database-resolver.ts";
import { StandaloneProjectStorageDirectory } from "./project-storage-directory.ts";
import { STANDALONE_NAMESPACE_PREFIX } from "./standalone-namespace.ts";

interface RelayEnvironment extends LiteSessionConfigurationEnvironment {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly SESSION_RELAY: DurableObjectNamespace;
    readonly SESSION_ARCHIVES?: R2Bucket;
}

function createContext(state: DurableObjectState, environment: RelayEnvironment) {
    const databases = new SingleDatabaseResolver(environment.DIRECTORY_DATABASE);
    const tenants = new StandaloneProjectStorageDirectory();
    return createDurableObjectContext(state, {
        environment,
        sessions: environment.SESSION_RELAY,
        namespacePrefix: STANDALONE_NAMESPACE_PREFIX,
        databases,
        projects: tenants,
        content:
            environment.SESSION_ARCHIVES === undefined
                ? { kind: "sqlite" }
                : { kind: "r2", buckets: new SingleBucketResolver(environment.SESSION_ARCHIVES) },
    });
}

export class RuntimeRelay extends RuntimeRelayImplementation {
    constructor(state: DurableObjectState, environment: RelayEnvironment) {
        super(createContext(state, environment));
    }
}

export class LiteSessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, environment: RelayEnvironment) {
        super(createContext(state, environment));
    }
}

export class SessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, environment: RelayEnvironment & { readonly SESSION_ARCHIVES: R2Bucket }) {
        super(createContext(state, environment));
    }
}
