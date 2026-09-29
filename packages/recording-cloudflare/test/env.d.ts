import type { RecordingWorkerBindings } from "../src/worker.ts";

declare global {
    namespace Cloudflare {
        interface Env extends RecordingWorkerBindings {}

        interface GlobalProps {
            readonly durableNamespaces: string;
            readonly mainModule: typeof import("../src/worker.ts");
        }
    }
}
