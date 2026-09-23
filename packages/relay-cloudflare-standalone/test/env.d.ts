import type { D1Migration } from "cloudflare:test";
import type { StandaloneRelayBindings } from "../src/worker.ts";

declare global {
    namespace Cloudflare {
        interface Env extends StandaloneRelayBindings {
            readonly TEST_MIGRATIONS: D1Migration[];
        }

        interface GlobalProps {
            readonly durableNamespaces: string;
            readonly mainModule: typeof import("../src/worker.ts");
        }
    }
}
