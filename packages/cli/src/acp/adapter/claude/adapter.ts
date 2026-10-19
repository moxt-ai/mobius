import type { Adapter, AdapterContext, NativeSessionPreviewRequest } from "../context.ts";

/**
 * Claude Code stores history that its harness replays as live ACP session updates
 * during `session/load`, so previews resume the saved session over ACP.
 */
export class ClaudeAdapter implements Adapter {
    readonly previewSessionEvents = async (request: NativeSessionPreviewRequest, context: AdapterContext) =>
        await context.previewThroughAcp(request);
}
