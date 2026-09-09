import {
    BotConnectionActor as BotConnectionImplementation,
    CloudflareBotConnectionRuntime,
    CloudflareChannelPeers,
    CloudflareSessionTransport,
    DurableObjectSqlDatabase,
    type LiteSessionConfigurationEnvironment,
    R2ContentStore,
    RuntimeRelay as RuntimeRelayImplementation,
    SessionRelay as SessionRelayImplementation,
    sessionArchiveByteLimitFromEnvironment,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import { createDurableObjectDependencies } from "@moxt-ai/mobius-relay-core";
import { SingleBucketResolver } from "./bucket-resolver.ts";
import { SingleDatabaseResolver } from "./database-resolver.ts";
import { StandaloneTenantShardingDirectory } from "./tenant-sharding-directory.ts";

interface RelayEnvironment extends LiteSessionConfigurationEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly SESSION_RELAY: DurableObjectNamespace;
    readonly SESSION_ARCHIVES?: R2Bucket;
}

function createContext(state: DurableObjectState, environment: RelayEnvironment) {
    const databases = new SingleDatabaseResolver(environment.DIRECTORY_DATABASE);
    const tenants = new StandaloneTenantShardingDirectory();
    const quota = sessionQuotaFromEnvironment(environment);
    return createDurableObjectDependencies({
        doDatabase: new DurableObjectSqlDatabase(state.storage),
        quota,
        content:
            environment.SESSION_ARCHIVES === undefined
                ? { kind: "sqlite", archiveByteLimit: sessionArchiveByteLimitFromEnvironment(environment) }
                : {
                      kind: "external",
                      content: new R2ContentStore(new SingleBucketResolver(environment.SESSION_ARCHIVES), tenants),
                  },
        gateways: {
            databaseResolver: databases,
            tenantShardingDirectory: tenants,
            sessionTransport: new CloudflareSessionTransport(environment.SESSION_RELAY),
            connections: new CloudflareBotConnectionRuntime(environment.BOT_CONNECTIONS),
            peers: new CloudflareChannelPeers(state),
            schedule: async (timestamp, signal) => {
                signal.throwIfAborted();
                await state.storage.setAlarm(timestamp);
                signal.throwIfAborted();
            },
        },
    });
}

export class RuntimeRelay extends RuntimeRelayImplementation {
    constructor(state: DurableObjectState, environment: RelayEnvironment) {
        super(createContext(state, environment));
    }
}

export class BotConnectionActor extends BotConnectionImplementation {
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
