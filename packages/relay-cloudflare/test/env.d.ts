import type { D1Migration } from "cloudflare:test";
import type { RelayBindings } from "../src/worker.ts";

interface RelayTestBindings extends RelayBindings {
  readonly TEST_MIGRATIONS: D1Migration[];
}

declare global {
  namespace Cloudflare {
    interface Env extends RelayTestBindings {}

    interface GlobalProps {
      readonly durableNamespaces: "RuntimeRelay" | "SessionRelay";
      readonly mainModule: typeof import("../src/worker.ts");
    }
  }
}
