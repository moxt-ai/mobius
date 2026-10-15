import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

import type { VerifiedRuntimeConnection } from "../../../../storage/runtime-installation-store.ts";

export interface SavedPairSummary {
    readonly appId: string;
    readonly connectionId: string;
    readonly runtimeId: string;
    readonly status: VerifiedRuntimeConnection["activation"];
    readonly workspace: string;
}

export function savedPairSummary(connection: VerifiedRuntimeConnection): SavedPairSummary {
    return {
        appId: connection.appId,
        connectionId: connection.connectionId,
        runtimeId: connection.runtimeId,
        workspace: connection.defaultWorkspace,
        status: connection.activation,
    };
}

export function formatPairTable(pairs: readonly SavedPairSummary[]): string {
    const headers = ["connection_id", "app_id", "runtime_id", "workspace", "status"];
    const rows = pairs.map((pair) => [pair.connectionId, pair.appId, pair.runtimeId, pair.workspace, pair.status]);
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
    );
    const line = (row: readonly string[]): string =>
        `| ${row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join(" | ")} |`;
    const divider = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`;
    return `${line(headers)}\n${divider}\n${rows.map(line).join("\n")}${rows.length === 0 ? "" : "\n"}`;
}

export async function writePairList(
    path: string,
    pairs: readonly SavedPairSummary[],
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    let file: FileHandle;
    try {
        file = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    } catch (cause) {
        if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
            throw new Error("The JSON output file does not exist", { cause });
        }
        throw new Error("The JSON output file cannot be written", { cause });
    }
    try {
        const metadata = await file.stat();
        if (!metadata.isFile()) {
            throw new Error("The JSON output path is not a regular file");
        }
        const output = pairs.map((pair) => ({
            app_id: pair.appId,
            connection_id: pair.connectionId,
            runtime_id: pair.runtimeId,
            status: pair.status,
            workspace: pair.workspace,
        }));
        signal.throwIfAborted();
        await file.truncate(0);
        await file.writeFile(`${JSON.stringify(output, null, 2)}\n`, "utf8");
    } finally {
        await file.close();
    }
}
