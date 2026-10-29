import { z } from "zod";
import { AcpExecutionError } from "../acp-error.ts";
import type { Adapter, NativeSessionLookupBudget } from "../native-history/preview-contract.ts";
import type { NativeSessionInfo } from "../protocol/native-session.ts";
import { nativeSessionIdSchema } from "../protocol/native-session.ts";

const lookupSchema = z.object({
    nativeSessionId: nativeSessionIdSchema,
    budget: z.object({
        maximumPages: z.number().int().min(1).max(500),
        maximumEntries: z.number().int().positive().nullable(),
    }),
});

/** ACP has no direct lookup operation; keep its bounded pagination inside the adapter. */
export async function findNativeSession(
    list: Adapter["listSessions"],
    cwd: string,
    nativeSessionId: string,
    budget: NativeSessionLookupBudget,
    signal: AbortSignal,
): Promise<NativeSessionInfo> {
    const decoded = lookupSchema.safeParse({ nativeSessionId, budget });
    if (!decoded.success) {
        throw new AcpExecutionError(
            "The native session lookup is invalid",
            { cause: decoded.error },
            "invalid_native_session_query",
        );
    }
    const limits = decoded.data.budget;
    let cursor: string | null = null;
    let inspected = 0;
    const visited = new Set<string>();
    for (let pageNumber = 0; pageNumber < limits.maximumPages; pageNumber += 1) {
        signal.throwIfAborted();
        const page = await list(cwd, cursor, signal);
        signal.throwIfAborted();
        inspected += page.sessions.length;
        const found = page.sessions.find((session) => session.sessionId === decoded.data.nativeSessionId);
        if (found !== undefined) {
            return found;
        }
        if (page.nextCursor == null || (limits.maximumEntries !== null && inspected >= limits.maximumEntries)) {
            break;
        }
        if (page.nextCursor === cursor || visited.has(page.nextCursor)) {
            throw new AcpExecutionError(
                "The Agent returned a repeated session cursor",
                {},
                "invalid_native_session_response",
            );
        }
        cursor = page.nextCursor;
        visited.add(cursor);
    }
    throw new AcpExecutionError("The native session was not found", {}, "native_session_not_found");
}
