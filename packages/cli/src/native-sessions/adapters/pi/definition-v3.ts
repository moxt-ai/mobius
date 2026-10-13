import { join } from "node:path";
import type { NativeSessionAdapterDefinitionV3 } from "../../runtime-manager-v3.ts";
import { connectPiNativeSessionV3, createPiNativeSessionV3 } from "./connected-v3.ts";
import { PiNativeSessionPreviewAdapterV3 } from "./preview-v3.ts";

export const piNativeSessionAdapterDefinitionV3: NativeSessionAdapterDefinitionV3 = {
    agentId: "pi",
    connect: connectPiNativeSessionV3,
    create: createPiNativeSessionV3,
    openPreview: async (agent) => ({
        adapter: new PiNativeSessionPreviewAdapterV3(
            agent.environment["PI_CODING_AGENT_SESSION_DIR"] ??
                (agent.environment["PI_CODING_AGENT_DIR"] === undefined
                    ? undefined
                    : join(agent.environment["PI_CODING_AGENT_DIR"], "sessions")),
        ),
        close: async () => undefined,
    }),
};
