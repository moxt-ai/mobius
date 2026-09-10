import type { D1Migration } from "cloudflare:test";
import type { PlatformRelayBindings } from "../src/worker.ts";

interface PlatformTestBindings extends PlatformRelayBindings {
    readonly TEST_PLATFORM_MIGRATIONS: D1Migration[];
    readonly TEST_PROJECT_MIGRATIONS: D1Migration[];
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
