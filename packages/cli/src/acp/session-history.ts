import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  type NativeHistoryMessage,
  type NativeSessionHistory,
  parseNativeHistoryText,
  SESSION_HISTORY_CHARACTER_LIMIT,
  SESSION_HISTORY_IMAGE_CHARACTER_LIMIT,
  SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT,
} from "@moxt-ai/mobius-protocol";
import { isProgressMessage } from "./activity.ts";

/** Captures ACP load replay without turning historical updates into live turns. */
export class AcpHistoryReplay {
  readonly #messages: NativeHistoryMessage[] = [];
  #lastMessageId: string | null = null;
  #characters = 0;
  #imageCharacters = 0;
  #truncated = false;

  readonly record = (update: SessionNotification["update"]): void => {
    if (
      update.sessionUpdate !== "user_message_chunk" &&
      update.sessionUpdate !== "agent_message_chunk"
    )
      return;
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      isProgressMessage(update)
    )
      return;
    const role =
      update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
    const content = update.content;
    const parsed = parseNativeHistoryText(
      content.type === "text"
        ? content.text
        : content.type === "image"
          ? `[@image](data:${content.mimeType};base64,${content.data})`
          : `[${content.type} attachment]`,
    );
    const text = parsed.text;
    if (text.length === 0 && parsed.images.length === 0) return;
    const previous = this.#messages.at(-1);
    const id = update.messageId ?? null;
    const continuation = previous?.role === role && id === this.#lastMessageId;
    const combined = continuation ? `${previous.text}${text}` : text;
    const allImages = continuation
      ? [...(previous.images ?? []), ...parsed.images]
      : parsed.images;
    const images = allImages.slice(0, 8);
    this.#truncated ||= images.length < allImages.length;
    if (continuation) {
      this.#messages.pop();
      this.#characters -= previous.text.length;
      this.#imageCharacters -= (previous.images ?? []).reduce(
        (size, image) => size + image.data.length,
        0,
      );
    }
    const bounded = combined.slice(-SESSION_HISTORY_CHARACTER_LIMIT);
    this.#truncated ||= bounded.length < combined.length;
    this.#messages.push({
      role,
      text: bounded,
      ...(images.length > 0 ? { images } : {}),
    });
    this.#characters += bounded.length;
    this.#imageCharacters += images.reduce(
      (size, image) => size + image.data.length,
      0,
    );
    this.#lastMessageId = id;
    while (
      this.#messages.length > SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT ||
      this.#characters > SESSION_HISTORY_CHARACTER_LIMIT ||
      this.#imageCharacters > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT
    ) {
      const removed = this.#messages.shift();
      if (removed !== undefined) {
        this.#characters -= removed.text.length;
        this.#imageCharacters -= (removed.images ?? []).reduce(
          (size, image) => size + image.data.length,
          0,
        );
      }
      this.#truncated = true;
    }
  };

  readonly snapshot = (): NativeSessionHistory => ({
    status: "available",
    messages: [...this.#messages],
    truncated: this.#truncated,
    coveredCommandIds: [],
  });
}
