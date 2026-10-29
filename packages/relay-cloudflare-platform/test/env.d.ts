import type { D1Migration } from "cloudflare:test";
import type { PlatformRelayBindings } from "../src/worker.ts";

interface PlatformTestBindings extends PlatformRelayBindings {
    readonly APP_CREDENTIAL_CACHE: KVNamespace;
    readonly MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY: string;
    readonly R2_BUCKET_WNAM: R2Bucket;
    readonly TEST_UNINITIALIZED_SHARD: D1Database;
    readonly TEST_PLATFORM_MIGRATIONS: D1Migration[];
}

declare global {
    namespace Cloudflare {
        interface Env extends PlatformTestBindings {}

        interface GlobalProps {
            readonly durableNamespaces: string;
            readonly mainModule: typeof import("../src/worker.ts");
        }
    }
}
