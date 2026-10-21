const CONVERSATION_TITLE_CHARACTER_LIMIT = 42;

/**
 * Derives a human-readable conversation title from the first turn's prompt text.
 *
 * Shared presentation helper for consumers of the SDK main entry; it is not part
 * of the wire protocol, so it lives outside the protocol layer.
 */
export function conversationTitleFromText(text: string): string {
    let compact = "";
    for (const line of text.split(/\r?\n/u)) {
        const candidate = line.replaceAll(/\s+/g, " ").trim();
        if (candidate.length === 0 || candidate.startsWith("```") || candidate.startsWith("~~~")) {
            continue;
        }
        const readable = candidate
            .replace(/^(?:>\s*)+/u, "")
            .replace(/^#{1,6}(?:\s+|$)/u, "")
            .replace(/^(?:[-*+]|\d+[.)])\s+/u, "")
            .trim();
        if (readable.length > 0) {
            compact = readable;
            break;
        }
    }
    if (compact.length === 0) {
        compact = text.replaceAll(/\s+/g, " ").trim();
    }
    const characters = Array.from(compact);
    if (characters.length <= CONVERSATION_TITLE_CHARACTER_LIMIT) {
        return compact;
    }
    return `${characters.slice(0, CONVERSATION_TITLE_CHARACTER_LIMIT - 1).join("")}…`;
}
