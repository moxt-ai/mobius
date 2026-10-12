import { execFile } from "node:child_process";
import type { ProcessTableEntry } from "./contracts.ts";

const PROCESS_TABLE_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_TABLE_OUTPUT_LIMIT_BYTES = 1024 * 1024;

function parseProcessTable(output: string): readonly ProcessTableEntry[] {
    const entries: ProcessTableEntry[] = [];
    for (const line of output.split("\n")) {
        const groups = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<pgid>\d+)\s*$/.exec(line)?.groups;
        if (groups === undefined) {
            continue;
        }
        const processId = Number(groups["pid"]);
        const parentProcessId = Number(groups["ppid"]);
        const processGroupId = Number(groups["pgid"]);
        if (
            !Number.isSafeInteger(processId) ||
            processId <= 0 ||
            !Number.isSafeInteger(parentProcessId) ||
            parentProcessId < 0 ||
            !Number.isSafeInteger(processGroupId) ||
            processGroupId <= 0
        ) {
            continue;
        }
        entries.push({ parentProcessId, processGroupId, processId });
    }
    return entries;
}

export function readProcessTableWithPs(executable: string): Promise<readonly ProcessTableEntry[]> {
    return new Promise((resolveTable) => {
        execFile(
            executable,
            ["-axo", "pid=,ppid=,pgid="],
            {
                encoding: "utf8",
                maxBuffer: PROCESS_TABLE_OUTPUT_LIMIT_BYTES,
                signal: AbortSignal.timeout(PROCESS_TABLE_TIMEOUT_MILLISECONDS),
                timeout: PROCESS_TABLE_TIMEOUT_MILLISECONDS,
            },
            (error, stdout) => {
                resolveTable(error === null ? parseProcessTable(stdout) : []);
            },
        );
    });
}

export function processExists(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch {
        return false;
    }
}
