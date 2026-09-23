import type { NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "../acp/acp-error.ts";
import type { NativeSessionAdapter, NativeSessionAdapterContext } from "./agent-adapter.ts";
import { readCodexFullHistory, readCodexHistory } from "./codex-history.ts";

async function verifiedHistory(context: NativeSessionAdapterContext, full: boolean): Promise<NativeSessionHistory> {
    const { options, nativeSessionId, directories, bindingId } = context;
    const snapshot = full
        ? await readCodexFullHistory(options.agent, options.cwd, nativeSessionId, options.signal)
        : await readCodexHistory(options.agent, options.cwd, nativeSessionId, options.signal);
    const resolved = await directories.identify(bindingId, snapshot.cwd, options.signal);
    if (snapshot.nativeSessionId !== nativeSessionId || resolved.path !== options.cwd) {
        throw new AcpExecutionError(
            "Codex returned history for a different session or workspace.",
            {},
            "invalid_native_session_response",
        );
    }
    return snapshot.history;
}

export const codexSessionAdapter: NativeSessionAdapter = {
    linkedHistory: async (context) => await verifiedHistory(context, true),
    history: async (context) => await verifiedHistory(context, true),
    // Codex enforces an exclusive writer per thread. Its read-only app-server
    // history path keeps externally owned conversations previewable.
    preview: async (context) => await verifiedHistory(context, false),
};
