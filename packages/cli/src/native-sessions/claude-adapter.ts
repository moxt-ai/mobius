import type { NativeSessionAdapter } from "./agent-adapter.ts";
import { readClaudeHistory } from "./claude-history.ts";

export const claudeSessionAdapter: NativeSessionAdapter = {
    linkedHistory: async ({ sessions, directories, bindingId, options, nativeSessionId }) =>
        await readClaudeHistory(sessions, directories, bindingId, options, nativeSessionId),
    history: async ({ sessions, directories, bindingId, options, nativeSessionId }) =>
        await readClaudeHistory(sessions, directories, bindingId, options, nativeSessionId),
    preview: async ({ sessions, options, nativeSessionId }) =>
        await sessions.previewNativeSession(options, nativeSessionId),
};
