import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";

export const SESSION_HISTORY_CHARACTER_LIMIT = 256_000;
export const SESSION_HISTORY_MESSAGE_LIMIT = 1_000;
export const SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT = 10;
export const SESSION_HISTORY_IMAGE_CHARACTER_LIMIT = 4_000_000;

const historyImage = z
    .strictObject({
        data: z
            .string()
            .min(4)
            .max(SESSION_HISTORY_IMAGE_CHARACTER_LIMIT)
            .refine((data) => data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)),
        mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
        name: z.string().min(1).max(500),
    })
    .readonly();

export type NativeHistoryImage = z.infer<typeof historyImage>;

/** Codex ACP serializes saved images as text links. Only embedded raster data
 * can be restored without granting filesystem or network access. */
export function parseNativeHistoryText(text: string): {
    readonly text: string;
    readonly images: readonly NativeHistoryImage[];
} {
    const images: NativeHistoryImage[] = [];
    let imageCharacters = 0;
    const plainText = text.replace(/\[@image\]\(([^)\r\n]*)(?:\)|$)/g, (_marker, uri: string) => {
        const header = /^data:(image\/[a-z+]+);base64,/.exec(uri);
        if (header === null) {
            return "[Image unavailable]";
        }
        const parsed = historyImage.safeParse({
            data: uri.slice(header[0].length),
            mimeType: header[1],
            name: `Image ${(images.length + 1).toString()}`,
        });
        if (
            !parsed.success ||
            images.length >= 8 ||
            imageCharacters + parsed.data.data.length > SESSION_HISTORY_IMAGE_CHARACTER_LIMIT
        ) {
            return "[Image unavailable]";
        }
        images.push(parsed.data);
        imageCharacters += parsed.data.data.length;
        return "";
    });
    return { text: plainText, images };
}

const historyMessage = z
    .strictObject({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(SESSION_HISTORY_CHARACTER_LIMIT),
        images: z.array(historyImage).max(8).readonly().optional(),
    })
    .readonly();

const sessionHistorySchema = z
    .discriminatedUnion("status", [
        z
            .strictObject({
                status: z.literal("available"),
                messages: z.array(historyMessage).max(SESSION_HISTORY_MESSAGE_LIMIT).readonly(),
                truncated: z.boolean(),
                coveredCommandIds: z
                    .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/))
                    .max(10_000)
                    .readonly(),
                coveredMessageIds: z
                    .array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}:(?:user|agent)$/))
                    .max(20_000)
                    .readonly()
                    .default([]),
            })
            .readonly(),
        z.strictObject({ status: z.literal("unavailable") }).readonly(),
    ])
    .refine(
        (history) =>
            history.status === "unavailable" ||
            (history.messages.reduce((total, message) => total + message.text.length, 0) <=
                SESSION_HISTORY_CHARACTER_LIMIT &&
                history.messages.reduce(
                    (total, message) =>
                        total + (message.images ?? []).reduce((size, image) => size + image.data.length, 0),
                    0,
                ) <= SESSION_HISTORY_IMAGE_CHARACTER_LIMIT),
    );

export type NativeSessionHistory = z.infer<typeof sessionHistorySchema>;
export type NativeHistoryMessage = z.infer<typeof historyMessage>;

export const decodeNativeSessionHistory = (value: unknown): NativeSessionHistory => {
    try {
        return sessionHistorySchema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid native session history", { cause });
    }
};
export { sessionHistorySchema };
