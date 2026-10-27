import type { ContentAvailableEvent, ContentWriteCommand, FileReadCommand } from "@moxt-ai/mobius-sdk/protocol";
import type { ProjectScope } from "../entity/do/session.ts";
import type { RuntimeControlCommand, RuntimeControlResult } from "../service/pairing/runtime-control-request.ts";

/** Session operations after the public API has authorized the selected Session. */
export interface SessionRuntimeOperations {
    readonly requestProjectScopeControl: (
        scope: ProjectScope,
        runtimeId: string,
        command: RuntimeControlCommand,
        signal: AbortSignal,
    ) => Promise<RuntimeControlResult>;
    readonly readProjectSessionFile: (
        scope: ProjectScope,
        runtimeId: string,
        command: FileReadCommand,
        signal: AbortSignal,
    ) => Promise<Response>;
    readonly writeProjectSessionContent: (
        scope: ProjectScope,
        runtimeId: string,
        command: ContentWriteCommand,
        body: ReadableStream<Uint8Array>,
        signal: AbortSignal,
    ) => Promise<ContentAvailableEvent>;
    readonly openProjectSessionEventHost: (
        scope: ProjectScope,
        runtimeId: string,
        sessionId: string,
        signal: AbortSignal,
    ) => Promise<{ readonly socket: WebSocket; readonly close: () => Promise<void> }>;
}
