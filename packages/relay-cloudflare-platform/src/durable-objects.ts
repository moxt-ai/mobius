import {
    BotConnectionActor as BotConnectionImplementation,
    CloudflareBotConnectionRuntime,
    CloudflareChannelPeers,
    CloudflareSessionTransport,
    DurableObjectSqlDatabase,
    type LiteSessionConfigurationEnvironment,
    RuntimeRelay as RuntimeRelayImplementation,
    SessionRelay as SessionRelayImplementation,
    sessionArchiveByteLimitFromEnvironment,
    sessionQuotaFromEnvironment,
} from "@moxt-ai/mobius-relay-cloudflare";
import { createDurableObjectDependencies } from "@moxt-ai/mobius-relay-core";
import { PlatformTenantShardingDirectory } from "./infra/platform-tenant-sharding-directory.ts";
import { PlatformDatabaseResolver } from "./storage/platform-database-resolver.ts";

interface PlatformDurableObjectEnvironment extends LiteSessionConfigurationEnvironment {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly SESSION_RELAY: DurableObjectNamespace;
}

function createContext(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
    const databases = new PlatformDatabaseResolver(environment.DIRECTORY_DATABASE);
    const tenants = new PlatformTenantShardingDirectory();
    return createDurableObjectDependencies({
        doDatabase: new DurableObjectSqlDatabase(state.storage),
        quota: sessionQuotaFromEnvironment(environment),
        content: {
            archiveByteLimit: sessionArchiveByteLimitFromEnvironment(environment),
            kind: "sqlite",
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
