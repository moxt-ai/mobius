import type { D1Migration } from "cloudflare:test";

interface PlatformDemoTestBindings {
    readonly BOT_CONNECTIONS: DurableObjectNamespace;
    readonly DIRECTORY_DATABASE: D1Database;
    readonly MOBIUS_DEMO_ALLOWED_ORIGIN: string;
    readonly MOBIUS_DEMO_DEVELOPER_TOKEN: string;
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
    readonly SESSION_ACTIVE_SESSIONS_PER_PROJECT: string;
    readonly SESSION_ACTIVE_SESSIONS_PER_TENANT: string;
    readonly SESSION_ARCHIVE_BYTES_PER_SESSION: string;
    readonly SESSION_RELAY: DurableObjectNamespace;
    readonly TEST_PLATFORM_MIGRATIONS: D1Migration[];
    readonly TEST_PROJECT_MIGRATIONS: D1Migration[];
}

declare global {
    namespace Cloudflare {
        interface Env extends PlatformDemoTestBindings {}
    }
}
