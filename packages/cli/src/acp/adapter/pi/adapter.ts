import type { Adapter, AdapterContext, NativeSessionPreviewRequest } from "../../native-history/preview-contract.ts";

/**
 * Pi replays its stored session messages as live ACP session updates during
 * `session/load`, so previews resume the saved session over ACP.
 */
export class PiAdapter implements Adapter {
    readonly previewSessionEvents = async (request: NativeSessionPreviewRequest, context: AdapterContext) =>
        await context.previewThroughAcp(request);
}
