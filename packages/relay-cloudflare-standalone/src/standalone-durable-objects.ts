import {
    createDurableObjectContext,
    type DoSqlDatabase,
    type LiteSessionConfigurationEnvironment,
    RuntimeRelay as RuntimeRelayImplementation,
} from "@moxt-ai/mobius-relay-core";
import { StandaloneDatabaseResolver } from "./standalone-database-resolver.ts";
import { StandaloneProjectStorageDirectory } from "./standalone-project-storage-directory.ts";

export interface StandaloneDurableObjectEnvironment extends LiteSessionConfigurationEnvironment {
    readonly DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

export function createStandaloneDurableObjectContext(
    state: DurableObjectState,
    environment: StandaloneDurableObjectEnvironment,
    doDatabase?: DoSqlDatabase,
) {
    return createDurableObjectContext(state, {
        environment,
        sessions: environment.SESSION_RELAY,
        namespacePrefix: "standalone",
        databases: new StandaloneDatabaseResolver(environment.DIRECTORY_DATABASE),
        projects: new StandaloneProjectStorageDirectory(),
        content: { kind: "sqlite" },
        ...(doDatabase === undefined ? {} : { doDatabase }),
    });
}

export class RuntimeRelay extends RuntimeRelayImplementation {
    constructor(state: DurableObjectState, environment: StandaloneDurableObjectEnvironment) {
        super(createStandaloneDurableObjectContext(state, environment));
    }
}
