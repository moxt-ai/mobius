import type { SessionPromptCommand } from "@moxt-ai/mobius-protocol";
import { SessionRuntimeError } from "./session.ts";

/** A tombstone retains scheduling metadata, never an executable prompt. */
export type NotRetainedTurnContent = {
    readonly kind: "not_retained";
    readonly disposition: SessionPromptCommand["disposition"];
    readonly targetCommandId: string;
};

export type StoredTurnContent =
    | { readonly kind: "retained"; readonly command: SessionPromptCommand }
    | NotRetainedTurnContent;

export function redactTurnCommand(encoded: string): string {
    try {
        const value: unknown = JSON.parse(encoded);
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("The stored command is not an object");
        }
        const command = Object.fromEntries(Object.entries(value));
        const disposition = command["disposition"] ?? "reject";
        const targetCommandId = command["targetCommandId"] ?? "";
        if (
            (disposition !== "reject" && disposition !== "queue" && disposition !== "steer") ||
            typeof targetCommandId !== "string" ||
            (targetCommandId !== "" && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(targetCommandId)) ||
            (disposition !== "reject" && targetCommandId === "")
        ) {
            throw new Error("The stored command scheduling metadata is invalid");
        }
        return JSON.stringify({ kind: "not_retained", disposition, targetCommandId });
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Turn request is invalid", { cause });
    }
}
