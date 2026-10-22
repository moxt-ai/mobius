import type {
    Adapter,
    AdapterContext,
    AdapterResolver,
    NativeSessionPreviewRequest,
} from "../../src/acp/native-history/preview-contract.ts";

/** Previews through ACP `session/load` regardless of the agent. */
class AcpPreviewAdapter implements Adapter {
    readonly previewSessionEvents = async (request: NativeSessionPreviewRequest, context: AdapterContext) =>
        await context.previewThroughAcp(request);
}

/** Routes every agent through the ACP preview, for agents that have no harness adapter. */
export const acpAdapters: AdapterResolver = () => new AcpPreviewAdapter();
