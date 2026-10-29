import type { ContentBlock } from "@agentclientprotocol/sdk";
import { z } from "zod";

const userContentSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]);

export function piUserMessageContent(content: unknown): readonly ContentBlock[] {
    if (typeof content === "string") {
        return content.length === 0 ? [] : [{ type: "text", text: content }];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    return content.flatMap((value: unknown): ContentBlock[] => {
        const parsed = userContentSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
    });
}

export function normalizePiAssistantText(content: unknown): string {
    // Assistant content is typically an array of blocks; only replay text blocks for MVP.
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
        .filter(Boolean)
        .join("");
}
