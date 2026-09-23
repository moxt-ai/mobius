import type { NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import { AcpExecutionError } from "../acp/acp-error.ts";
import type { AcpPrepareOptions } from "../acp/session-manager.ts";
import type { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";
import { readCodexFullHistory } from "./codex-history.ts";

export async function readCodexLinkedHistory(
    directories: WorkspaceDirectoryService,
    bindingId: string,
    options: AcpPrepareOptions,
    nativeSessionId: string,
): Promise<NativeSessionHistory> {
    const snapshot = await readCodexFullHistory(options.agent, options.cwd, nativeSessionId, options.signal);
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
