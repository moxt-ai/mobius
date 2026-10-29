import type { NativeSessionQuery } from "../../acp/native-history/preview-contract.ts";
import type { SessionPrepareOptions } from "../api/session-api.ts";

/** Keep product identity and media ownership on the caller's side of the adapter. */
export function nativeSessionQuery(options: SessionPrepareOptions): NativeSessionQuery {
    const externalize = options.externalizeSessionUpdate;
    return {
        agent: options.agent,
        cwd: options.cwd,
        additionalDirectories: options.additionalDirectories,
        signal: options.signal,
        ...(externalize === undefined
            ? {}
            : { externalizeUpdate: (update, signal) => externalize(options.sessionId, update, signal) }),
    };
}
