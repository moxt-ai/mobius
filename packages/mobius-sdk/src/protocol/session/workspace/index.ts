import { z } from "zod";

import { identifierStringSchema as IDENTIFIER } from "../../shared/identifier.ts";
import { decodeZodMessage as decode, encodeZodMessage as encode } from "../../shared/message-codec.ts";
import { DIRECTORY_IDENTIFIER, workspaceEntrySchema } from "../shared/index.ts";

export const WORKSPACE_LIST_KIND = "workspace.list";
export const WORKSPACE_ENTRIES_KIND = "workspace.entries";
export const RUNTIME_WORKSPACE_BINDING_ID = "workspace";

const workspaceListCommandSchema = z
    .object({
        bindingId: IDENTIFIER,
        directoryId: DIRECTORY_IDENTIFIER,
        kind: z.literal(WORKSPACE_LIST_KIND),
        requestId: IDENTIFIER,
    })
    .readonly();

export type WorkspaceListCommand = z.infer<typeof workspaceListCommandSchema>;

const workspaceEntriesEventSchema = z
    .object({
        bindingId: IDENTIFIER,
        directoryId: DIRECTORY_IDENTIFIER,
        directoryLabel: z.string().min(1).max(2_048),
        entries: z.array(workspaceEntrySchema).max(500).readonly(),
        kind: z.literal(WORKSPACE_ENTRIES_KIND),
        parentDirectoryId: z.string().max(2_048),
        requestId: IDENTIFIER,
    })
    .readonly();

export type WorkspaceEntriesEvent = z.infer<typeof workspaceEntriesEventSchema>;

export const decodeWorkspaceListCommand = (encoded: string): WorkspaceListCommand =>
    decode(encoded, workspaceListCommandSchema);
export const encodeWorkspaceListCommand = (message: WorkspaceListCommand): string =>
    encode(message, workspaceListCommandSchema);
export const decodeWorkspaceEntriesEvent = (encoded: string): WorkspaceEntriesEvent =>
    decode(encoded, workspaceEntriesEventSchema);
export const encodeWorkspaceEntriesEvent = (message: WorkspaceEntriesEvent): string =>
    encode(message, workspaceEntriesEventSchema);
