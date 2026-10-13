import type { NativeSessionAdapterDefinitionV3 } from "../../runtime-manager-v3.ts";
import { connectClaudeNativeSessionV3, createClaudeNativeSessionV3 } from "./connected-v3.ts";
import { ClaudeNativeSessionPreviewAdapterV3 } from "./preview-v3.ts";

export const claudeNativeSessionAdapterDefinitionV3: NativeSessionAdapterDefinitionV3 = {
    agentId: "claude",
    connect: connectClaudeNativeSessionV3,
    create: createClaudeNativeSessionV3,
    openPreview: async (agent) => ({
        adapter: new ClaudeNativeSessionPreviewAdapterV3(agent.environment["CLAUDE_CONFIG_DIR"]),
        close: async () => undefined,
    }),
};
