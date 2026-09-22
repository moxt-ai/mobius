import type { SessionPromptCommand } from "@moxt-ai/mobius-protocol";

/** A tombstone retains scheduling metadata, never an executable prompt. */
export type NotRetainedTurnContent = {
    readonly kind: "not_retained";
    readonly disposition: SessionPromptCommand["disposition"];
    readonly targetCommandId: string;
};

export type StoredTurnContent =
    | { readonly kind: "retained"; readonly command: SessionPromptCommand }
    | NotRetainedTurnContent;
