import type { NativeSessionAdapterDefinitionV3 } from "../../runtime-manager-v3.ts";
import { connectCodexNativeSessionV3, createCodexNativeSessionV3 } from "./connected-v3.ts";
import { openCodexNativeSessionPreviewV3 } from "./runtime-v3.ts";

export const codexNativeSessionAdapterDefinitionV3: NativeSessionAdapterDefinitionV3 = {
    agentId: "codex",
    connect: async (agent, session, live, signal) => await connectCodexNativeSessionV3(agent, session, live, signal),
    create: async (agent, session, live, signal) => await createCodexNativeSessionV3(agent, session, live, signal),
    openPreview: async (agent, session, signal) => await openCodexNativeSessionPreviewV3(agent, session.cwd, signal),
};
