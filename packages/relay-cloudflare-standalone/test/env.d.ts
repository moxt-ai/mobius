import type { D1Migration } from "cloudflare:test";
import type { RelayBindings } from "../src/worker.ts";

interface RelayTestBindings extends RelayBindings {
    readonly TEST_LEGACY_AGENT_CATALOG_MIGRATION: readonly string[];
    readonly TEST_MIGRATIONS: D1Migration[];
}

declare global {
    namespace Cloudflare {
        interface Env extends RelayTestBindings {}

        interface GlobalProps {
            readonly durableNamespaces: string;
            readonly mainModule: typeof import("../src/worker.ts");
        }
    }
}
