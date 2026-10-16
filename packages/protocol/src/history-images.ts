import { z } from "zod";

export const SESSION_HISTORY_IMAGE_CHARACTER_LIMIT = 4_000_000;
/** Page size the native history preview reader requests from a saved Agent thread. */
export const SESSION_HISTORY_PREVIEW_MESSAGE_LIMIT = 10;

const historyImage = z
    .object({
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
