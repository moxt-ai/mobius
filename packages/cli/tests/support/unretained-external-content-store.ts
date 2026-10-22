import { createHash } from "node:crypto";
import type { ExternalContentStore } from "../../src/acp/external-content/local-external-content-store.ts";

/** Hashes content into a stable reference but retains nothing and resolves no request. */
export class UnretainedExternalContentStore implements ExternalContentStore {
    readonly put: ExternalContentStore["put"] = async ({ bytes, signal }) => {
        signal.throwIfAborted();
        return { byteLength: bytes.byteLength, key: createHash("sha256").update(bytes).digest("hex") };
    };

    readonly resolve: ExternalContentStore["resolve"] = (_sessionId, _request, signal) => {
        signal.throwIfAborted();
        return Promise.resolve(null);
    };
}
