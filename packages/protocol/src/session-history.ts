import { z } from "zod";
import { ProtocolMessageError } from "./codecs/messages.ts";
import { displayContentSchema } from "./control-messages.ts";
import { identifierStringSchema, isIdentifier } from "./identifier.ts";

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

const nativeMessageActivitySchema = z
    .strictObject({
        activityId: z.string().min(1).max(128),
        activityType: z.string().min(1).max(128),
        content: z.array(displayContentSchema).max(100).readonly(),
        input: z.string().max(100_000),
        locations: z.array(z.string().min(1).max(2_048)).max(100).readonly(),
        name: z.string().max(128),
        output: z.string().max(100_000),
        sequence: z.number().int().nonnegative(),
        status: z.string().min(1).max(64),
        title: z.string().max(500),
        toolKind: z.string().max(64),
    })
    .readonly();

const userHistoryMessage = z
    .strictObject({
        role: z.literal("user"),
        text: z.string().max(SESSION_HISTORY_CHARACTER_LIMIT),
        images: z.array(historyImage).max(8).readonly().optional(),
    })
    .readonly();
const assistantHistoryMessage = z
    .strictObject({
        activities: z.array(nativeMessageActivitySchema).max(100).readonly().default([]),
        content: z.array(displayContentSchema).max(100).readonly().default([]),
        role: z.literal("assistant"),
        text: z.string().max(SESSION_HISTORY_CHARACTER_LIMIT),
        images: z.array(historyImage).max(8).readonly().optional(),
    })
    .readonly();
const historyMessage = z.discriminatedUnion("role", [userHistoryMessage, assistantHistoryMessage]);

const availableSessionHistoryObjectSchema = z.strictObject({
    status: z.literal("available"),
    messages: z.array(historyMessage).max(SESSION_HISTORY_MESSAGE_LIMIT).readonly(),
    truncated: z.boolean(),
    coveredCommandIds: z.array(identifierStringSchema).max(10_000).readonly(),
    coveredMessageIds: z
        .array(
            z.string().refine((value) => {
                const suffix = value.endsWith(":user") ? ":user" : value.endsWith(":agent") ? ":agent" : null;
                return suffix !== null && isIdentifier(value.slice(0, -suffix.length));
            }),
        )
        .max(20_000)
        .readonly()
        .default([]),
});
const availableSessionHistorySchema = availableSessionHistoryObjectSchema.readonly();
const unavailableSessionHistoryObjectSchema = z.strictObject({
    status: z.literal("unavailable"),
    cause: z
        .strictObject({
            code: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
            message: z.string().min(1).max(1_000),
        })
        .readonly(),
});
const unavailableSessionHistorySchema = unavailableSessionHistoryObjectSchema.readonly();
function withinHistoryContentLimits(history: {
    readonly status: "available" | "unavailable";
    readonly messages?: readonly z.infer<typeof historyMessage>[];
}): boolean {
    if (history.status === "unavailable" || history.messages === undefined) {
        return true;
    }
    return (
        history.messages.reduce(
            (total, message) =>
                total +
                message.text.length +
                (message.role === "assistant"
                    ? JSON.stringify(message.activities).length + JSON.stringify(message.content).length
                    : 0),
            0,
        ) <= SESSION_HISTORY_CHARACTER_LIMIT &&
        history.messages.reduce(
            (total, message) => total + (message.images ?? []).reduce((size, image) => size + image.data.length, 0),
            0,
        ) <= SESSION_HISTORY_IMAGE_CHARACTER_LIMIT
    );
}
const sessionHistorySchema = z
    .discriminatedUnion("status", [availableSessionHistorySchema, unavailableSessionHistorySchema])
    .refine(withinHistoryContentLimits);

export type NativeSessionHistory = z.infer<typeof sessionHistorySchema>;
export type NativeHistoryMessage = z.infer<typeof historyMessage>;
export type NativeMessageActivity = z.infer<typeof nativeMessageActivitySchema>;
const nativeMessagePageSchema = z
    .discriminatedUnion("status", [
        availableSessionHistoryObjectSchema.extend({ nextCursor: z.string().max(512).nullable() }).readonly(),
        unavailableSessionHistoryObjectSchema.extend({ nextCursor: z.null() }).readonly(),
    ])
    .refine(withinHistoryContentLimits);
export type NativeMessagePage = z.infer<typeof nativeMessagePageSchema>;

export const decodeNativeSessionHistory = (value: unknown): NativeSessionHistory => {
    try {
        return sessionHistorySchema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid native session history", { cause });
    }
};
export const decodeNativeMessagePage = (value: unknown): NativeMessagePage => {
    try {
        return nativeMessagePageSchema.parse(value);
    } catch (cause) {
        throw new ProtocolMessageError("Invalid native message page", { cause });
    }
};
export { nativeMessagePageSchema, sessionHistorySchema };
