const CONNECTION_ID_PATTERN = /^mcn_[a-f0-9]{32}$/;

export type ManagedRuntimeStatus = "starting" | "online" | "reconnecting" | "failed" | "stopped";

export interface ManagedRuntimeSummary {
    readonly appId: string;
    readonly connectionId: string;
    readonly runtimeId: string;
    readonly status: ManagedRuntimeStatus;
    readonly workspace: string;
}

export type ManagerCommand =
    | { readonly kind: "list" }
    | { readonly arguments: readonly string[]; readonly kind: "pair" }
    | { readonly connectionId: string; readonly kind: "remove-pair" }
    | { readonly arguments: readonly string[]; readonly kind: "start" }
    | { readonly connectionId: string; readonly kind: "stop-pair" }
    | { readonly kind: "stop" };

export type ManagerResponse =
    | { readonly kind: "error"; readonly code: string; readonly message: string }
    | {
          readonly kind: "listed";
          readonly managerVersion: string;
          readonly pairs: readonly ManagedRuntimeSummary[];
      }
    | { readonly connectionId: string; readonly kind: "pair-removed" }
    | { readonly kind: "pair-stopped"; readonly pair: ManagedRuntimeSummary }
    | { readonly alreadyOnline: boolean; readonly kind: "ready"; readonly pair: ManagedRuntimeSummary }
    | { readonly kind: "stopped" };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeCommand(value: unknown, expectedToken: string): ManagerCommand {
    if (!isRecord(value) || value["token"] !== expectedToken || typeof value["kind"] !== "string") {
        throw new Error("The manager request is invalid");
    }
    if (value["kind"] === "list" || value["kind"] === "stop") {
        return { kind: value["kind"] };
    }
    if (
        (value["kind"] === "remove-pair" || value["kind"] === "stop-pair") &&
        typeof value["connectionId"] === "string" &&
        CONNECTION_ID_PATTERN.test(value["connectionId"])
    ) {
        return { connectionId: value["connectionId"], kind: value["kind"] };
    }
    if (value["kind"] === "pair" || value["kind"] === "start") {
        const arguments_ = value["arguments"];
        if (
            !Array.isArray(arguments_) ||
            arguments_.length > 16 ||
            !arguments_.every((argument) => typeof argument === "string" && argument.length <= 4096)
        ) {
            throw new Error("The manager command arguments are invalid");
        }
        return { arguments: arguments_, kind: value["kind"] };
    }
    throw new Error("The manager command is unsupported");
}

export function decodeResponse(value: unknown): ManagerResponse {
    if (!isRecord(value) || typeof value["kind"] !== "string") {
        throw new Error("The Mobius manager returned an invalid response");
    }
    if (value["kind"] === "error" && typeof value["code"] === "string" && typeof value["message"] === "string") {
        return { code: value["code"], kind: "error", message: value["message"] };
    }
    if (value["kind"] === "stopped") {
        return { kind: "stopped" };
    }
    if (value["kind"] === "pair-stopped" && isManagedRuntimeSummary(value["pair"])) {
        return { kind: "pair-stopped", pair: value["pair"] };
    }
    if (value["kind"] === "pair-removed" && typeof value["connectionId"] === "string") {
        return { connectionId: value["connectionId"], kind: "pair-removed" };
    }
    if (
        value["kind"] === "ready" &&
        typeof value["alreadyOnline"] === "boolean" &&
        isManagedRuntimeSummary(value["pair"])
    ) {
        return { alreadyOnline: value["alreadyOnline"], kind: "ready", pair: value["pair"] };
    }
    if (value["kind"] === "listed" && Array.isArray(value["pairs"]) && value["pairs"].every(isManagedRuntimeSummary)) {
        const managerVersion = value["managerVersion"];
        if (typeof managerVersion === "string" && managerVersion.length > 0 && managerVersion.length <= 128) {
            return { kind: "listed", managerVersion, pairs: value["pairs"] };
        }
    }
    throw new Error("The Mobius manager returned an invalid response");
}

function isManagedRuntimeSummary(value: unknown): value is ManagedRuntimeSummary {
    return (
        isRecord(value) &&
        typeof value["appId"] === "string" &&
        typeof value["connectionId"] === "string" &&
        typeof value["runtimeId"] === "string" &&
        typeof value["workspace"] === "string" &&
        ["starting", "online", "reconnecting", "failed", "stopped"].includes(String(value["status"]))
    );
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown failure";
}
