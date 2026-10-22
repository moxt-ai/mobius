import type { VerifiedRuntimeConnection } from "../../../../runtime/connection/runtime-connection.ts";
import { writeExistingFile } from "../../../../storage/files/output-file.ts";

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
    const output = pairs.map((pair) => ({
        app_id: pair.appId,
        connection_id: pair.connectionId,
        runtime_id: pair.runtimeId,
        status: pair.status,
        workspace: pair.workspace,
    }));
    const write = await writeExistingFile(path, `${JSON.stringify(output, null, 2)}\n`, signal);
    switch (write.kind) {
        case "written":
            return;
        case "missing":
            throw new Error("The JSON output file does not exist", { cause: write.cause });
        case "unwritable":
            throw new Error("The JSON output file cannot be written", { cause: write.cause });
        case "not-a-file":
            throw new Error("The JSON output path is not a regular file");
    }
}
