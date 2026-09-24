import { readAcpHistory } from "./acp-history.ts";
import type { NativeSessionAdapter } from "./agent-adapter.ts";

export const acpSessionAdapter: NativeSessionAdapter = {
    history: async ({ sessions, directories, bindingId, options, nativeSessionId }) =>
        await readAcpHistory(sessions, directories, bindingId, options, nativeSessionId),
    preview: async ({ sessions, options, nativeSessionId }) =>
        await sessions.previewNativeSession(options, nativeSessionId),
};
