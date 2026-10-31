import { SESSION_RECORDING_TITLE_MAX_LENGTH } from "@moxt-ai/mobius-sdk/protocol";

/**
 * The Session title a Recording keeps for a title an Agent reports: trimmed and cut to what a summary or Turn
 * history page carries. Applying it again leaves its result unchanged.
 */
export function recordedSessionTitle(title: string): string {
    return title.trim().slice(0, SESSION_RECORDING_TITLE_MAX_LENGTH).trimEnd();
}
