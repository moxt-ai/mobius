import type { NativeSessionPreviewAdapterV3 } from "../adapter-v3.ts";
import type { CodexAppServerClient } from "./app-server-client.ts";
import { CodexHistoryAdapterV3 } from "./history-v3.ts";

/** Queries history through an App Server transport owned by the adapter runtime. */
export class CodexNativeSessionPreviewAdapterV3 implements NativeSessionPreviewAdapterV3 {
    readonly #history: CodexHistoryAdapterV3;

    constructor(appServer: CodexAppServerClient) {
        this.#history = new CodexHistoryAdapterV3(appServer);
    }

    readonly previewMessages: NativeSessionPreviewAdapterV3["previewMessages"] = async (session, request, signal) => {
        const page = await this.#history.page(session.nativeSessionId, request, signal);
        return { ...page, throughSeq: 0 };
    };
}
