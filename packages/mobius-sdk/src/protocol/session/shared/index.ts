import { z } from "zod";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";

export const DIRECTORY_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
export const DIRECTORY_IDENTIFIER = z.string().min(1).max(2_048).regex(DIRECTORY_IDENTIFIER_PATTERN);
export const SHORT_TEXT = z.string().max(500);

export const workspaceEntrySchema = z
    .object({
        directoryId: DIRECTORY_IDENTIFIER,
        name: z.string().min(1).max(255),
    })
    .readonly();

export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export const sessionStatusSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("idle") }).readonly(),
    z
        .object({
            commandId: IDENTIFIER,
            kind: z.literal("working"),
        })
        .readonly(),
]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionCapabilitiesSchema = z
    .object({
        additionalDirectories: z.boolean(),
        audioPrompt: z.boolean(),
        closeSession: z.boolean(),
        deleteSession: z.boolean(),
        embeddedContextPrompt: z.boolean(),
        imagePrompt: z.boolean(),
        listSessions: z.boolean(),
        loadSession: z.boolean(),
        promptQueueing: z.boolean().default(false),
        renameSession: z.boolean().default(false),
        resumeSession: z.boolean(),
        steering: z.boolean().default(false),
        unstableForkSession: z.boolean().default(false),
    })
    .readonly();

export type SessionCapabilities = z.infer<typeof sessionCapabilitiesSchema>;

export const sessionCommandSchema = z
    .object({
        description: SHORT_TEXT,
        inputHint: z.string().max(255),
        name: z.string().min(1).max(128),
    })
    .readonly();

export type SessionCommand = z.infer<typeof sessionCommandSchema>;

export const configValueSchema = z
    .object({
        description: SHORT_TEXT,
        groupId: z.string().max(128),
        groupName: z.string().max(255),
        name: z.string().min(1).max(255),
        // ACP types a select value id as any string, and Agents use the empty
        // id to mean "the provider's own default" — no explicit setting is
        // sent. Refusing it would drop the whole option, so the id is bounded
        // by length alone.
        value: z.string().max(500),
    })
    .readonly();

export type SessionConfigValue = z.infer<typeof configValueSchema>;

export const sessionIdentityFields = {
    additionalDirectoryIds: z.array(DIRECTORY_IDENTIFIER).max(16).readonly(),
    agentId: IDENTIFIER,
    bindingId: IDENTIFIER,
    directoryId: DIRECTORY_IDENTIFIER,
    sessionId: IDENTIFIER,
};
