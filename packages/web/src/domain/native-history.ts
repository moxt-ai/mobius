import type {
    AgentDisplayContent,
    NativeHistoryMessage,
    NativeSessionHistory as ProtocolHistory,
} from "@moxt-ai/mobius-protocol";

export type PresentedNativeMessage = NativeHistoryMessage & { readonly content?: readonly AgentDisplayContent[] };
export type NativeSessionHistory =
    | Extract<ProtocolHistory, { readonly status: "unavailable" }>
    | (Omit<Extract<ProtocolHistory, { readonly status: "available" }>, "messages"> & {
          readonly messages: readonly PresentedNativeMessage[];
      });
