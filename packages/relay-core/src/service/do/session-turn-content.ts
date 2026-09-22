import { decodeSessionPromptCommand } from "@moxt-ai/mobius-protocol";
import { SessionRuntimeError } from "../../entity/do/session.ts";
import type { TurnRecord } from "../../entity/do/session-records.ts";
import type { NotRetainedTurnContent, StoredTurnContent } from "../../entity/do/session-retention.ts";

function commandRecord(encoded: string): Readonly<Record<string, unknown>> {
    const value: unknown = JSON.parse(encoded);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("The stored command is not an object");
    }
    return Object.fromEntries(Object.entries(value));
}

function tombstone(value: Readonly<Record<string, unknown>>): NotRetainedTurnContent {
    const disposition = value["disposition"] ?? "reject";
    const targetCommandId = value["targetCommandId"] ?? "";
    if (
        (disposition !== "reject" && disposition !== "queue" && disposition !== "steer") ||
        typeof targetCommandId !== "string" ||
        (targetCommandId !== "" && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(targetCommandId)) ||
        (disposition !== "reject" && targetCommandId === "")
    ) {
        throw new Error("The stored command scheduling metadata is invalid");
    }
    return { kind: "not_retained", disposition, targetCommandId };
}

export function redactTurnCommand(encoded: string): string {
    try {
        return JSON.stringify(tombstone(commandRecord(encoded)));
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Turn request is invalid", { cause });
    }
}

/** Recognize only the invalid empty prompt written by the former retention cleanup. */
export function isLegacyScrubbedTurnCommand(encoded: string): boolean {
    try {
        const value = commandRecord(encoded);
        if (
            value["kind"] !== "session.prompt" ||
            value["prompt"] !== "" ||
            !Array.isArray(value["images"]) ||
            value["images"].length !== 0 ||
            !Array.isArray(value["resources"]) ||
            value["resources"].length !== 0
        ) {
            return false;
        }
        tombstone(value);
        return true;
    } catch {
        // Leave unrelated corruption for the owning read boundary to report. It must
        // not prevent the entire Durable Object from starting during this repair.
        return false;
    }
}

export function storedTurnContent(row: TurnRecord): StoredTurnContent {
    try {
        const value = commandRecord(row.command_json);
        if (value["kind"] === "not_retained") {
            if (
                Object.keys(value).sort().join(",") !== "disposition,kind,targetCommandId" ||
                (row.state !== "succeeded" && row.state !== "failed" && row.state !== "cancelled")
            ) {
                throw new Error("Only completed Turns can have a content tombstone");
            }
            return tombstone(value);
        }
        return { command: decodeSessionPromptCommand(row.command_json), kind: "retained" };
    } catch (cause) {
        throw new SessionRuntimeError("session_storage_unavailable", "The stored Turn request is invalid", { cause });
    }
}
