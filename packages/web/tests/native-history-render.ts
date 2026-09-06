import { decodeNativeSessionHistory } from "@moxt-ai/mobius-web-sdk";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeSessionHistoryView } from "@/components/chat-message-list";

export function renderNativeHistory(history: unknown): string {
  return renderToStaticMarkup(
    createElement(NativeSessionHistoryView, {
      agentLabel: "Codex",
      history: decodeNativeSessionHistory(history),
    }),
  );
}
