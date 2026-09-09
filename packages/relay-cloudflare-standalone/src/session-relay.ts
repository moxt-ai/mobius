import {
    CloudflareBotConnectionRuntime,
    DurableObjectContentStore,
    type LiteSessionConfigurationEnvironment,
    R2ContentStore,
    SessionRelay as SessionRelayImplementation,
    sessionArchiveByteLimitFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import { SingleBucketResolver } from "./bucket-resolver.ts";
import { SingleDatabaseResolver } from "./database-resolver.ts";
import { StandaloneTenantShardingDirectory } from "./tenant-sharding-directory.ts";

interface RelayEnvironment extends LiteSessionConfigurationEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
}

export class LiteSessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, environment: RelayEnvironment) {
        super(
            state,
            environment,
            new DurableObjectContentStore(state.storage, sessionArchiveByteLimitFromEnvironment(environment)),
            new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
            new StandaloneTenantShardingDirectory(),
            new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
        );
    }
}

export class SessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, environment: RelayEnvironment & { readonly SESSION_ARCHIVES: R2Bucket }) {
        const tenants = new StandaloneTenantShardingDirectory();
        super(
            state,
            environment,
            new R2ContentStore(new SingleBucketResolver(environment.SESSION_ARCHIVES), tenants),
            new SingleDatabaseResolver(environment.DIRECTORY_DATABASE),
            tenants,
            new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
        );
    }
}
