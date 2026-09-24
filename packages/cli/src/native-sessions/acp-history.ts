import type { NativeSessionHistory } from "@moxt-ai/mobius-protocol";
import type { AcpPrepareOptions, AcpSessionManager } from "../acp/session-manager.ts";
import { AcpExecutionError } from "../acp/session-manager.ts";
import type { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";

/** ACP session/list verifies ownership before session/load replays saved messages. */
export async function readAcpHistory(
    sessions: AcpSessionManager,
    directories: WorkspaceDirectoryService,
    bindingId: string,
    options: AcpPrepareOptions,
    nativeSessionId: string,
): Promise<NativeSessionHistory> {
    let cursor: string | null = null;
    let inspected = 0;
    for (let pageNumber = 0; pageNumber < 500 && inspected < 500; pageNumber += 1) {
        const page = await sessions.listNativeSessions(options, cursor);
        inspected += page.sessions.length;
        const found = page.sessions.find((entry) => entry.sessionId === nativeSessionId);
        if (found !== undefined) {
            const primary = await directories.identify(bindingId, found.cwd, options.signal);
            const additional = await Promise.all(
                found.additionalDirectories.map(
                    async (directory) => await directories.identify(bindingId, directory, options.signal),
                ),
            );
            if (
                primary.path !== options.cwd ||
                additional.length !== options.additionalDirectories.length ||
                additional.some((directory, index) => directory.path !== options.additionalDirectories[index])
            ) {
                throw new AcpExecutionError(
                    "The native Session belongs to another workspace.",
                    {},
                    "session_identity_mismatch",
                );
            }
            return await sessions.previewNativeSession(options, nativeSessionId);
        }
        if (page.nextCursor === null || page.nextCursor === cursor) {
            break;
        }
        cursor = page.nextCursor ?? null;
    }
    throw new AcpExecutionError("The native Session was not found.", {}, "native_session_not_found");
}
