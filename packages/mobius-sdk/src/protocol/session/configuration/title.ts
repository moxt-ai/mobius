import { z } from "zod";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";

export const SESSION_RENAME_KIND = "session.rename";
export const SESSION_RENAMED_KIND = "session.renamed";

const sessionRenameCommandSchema = z
    .object({
        kind: z.literal(SESSION_RENAME_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
        title: z.string().min(1).max(500),
    })
    .readonly();

export type SessionRenameCommand = z.infer<typeof sessionRenameCommandSchema>;

const sessionRenamedEventSchema = z
    .object({
        kind: z.literal(SESSION_RENAMED_KIND),
        requestId: IDENTIFIER,
        sessionId: IDENTIFIER,
        title: z.string().min(1).max(500),
        updatedAt: z.string().max(128),
    })
    .readonly();

export type SessionRenamedEvent = z.infer<typeof sessionRenamedEventSchema>;

export const decodeSessionRenameCommand = (encoded: string): SessionRenameCommand =>
    decode(encoded, sessionRenameCommandSchema);
export const encodeSessionRenameCommand = (message: SessionRenameCommand): string =>
    encode(message, sessionRenameCommandSchema);
export const decodeSessionRenamedEvent = (encoded: string): SessionRenamedEvent =>
    decode(encoded, sessionRenamedEventSchema);
export const encodeSessionRenamedEvent = (message: SessionRenamedEvent): string =>
    encode(message, sessionRenamedEventSchema);
