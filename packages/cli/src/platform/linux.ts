import { constants, readdirSync, readFileSync } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PlatformSupport, ProcessTableEntry } from "./contracts.ts";
import { posixOperations, processExists as posixProcessExists, readProcessTableWithPs } from "./posix.ts";

function appendLinuxProcessTableEntry(entries: ProcessTableEntry[], processId: number, encoded: string): void {
    const closingParenthesis = encoded.lastIndexOf(")");
    if (!encoded.startsWith(`${processId.toString()} (`) || closingParenthesis < 0) {
        return;
    }
    const fields = encoded
        .slice(closingParenthesis + 1)
        .trim()
        .split(/\s+/);
    const parentProcessId = Number(fields[1]);
    const processGroupId = Number(fields[2]);
    if (
        !Number.isSafeInteger(parentProcessId) ||
        parentProcessId < 0 ||
        !Number.isSafeInteger(processGroupId) ||
        processGroupId <= 0
    ) {
        return;
    }
    entries.push({ parentProcessId, processGroupId, processId });
}

async function readLinuxProcessTable(): Promise<readonly ProcessTableEntry[]> {
    const entries: ProcessTableEntry[] = [];
    try {
        const directories = await readdir("/proc", { withFileTypes: true });
        for (const directory of directories) {
            if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) {
                continue;
            }
            const processId = Number(directory.name);
            if (!Number.isSafeInteger(processId) || processId <= 0) {
                continue;
            }
            try {
                appendLinuxProcessTableEntry(
                    entries,
                    processId,
                    await readFile(join("/proc", directory.name, "stat"), "utf8"),
                );
            } catch {
                // Processes can exit while procfs is being enumerated.
            }
        }
    } catch {
        // A restricted Linux runtime may not mount procfs; the fixed ps fallback runs below.
    }
    return entries;
}

function readLinuxProcessTableSynchronously(): readonly ProcessTableEntry[] {
    const entries: ProcessTableEntry[] = [];
    try {
        const directories = readdirSync("/proc", { withFileTypes: true });
        for (const directory of directories) {
            if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) {
                continue;
            }
            const processId = Number(directory.name);
            if (!Number.isSafeInteger(processId) || processId <= 0) {
                continue;
            }
            try {
                appendLinuxProcessTableEntry(
                    entries,
                    processId,
                    readFileSync(join("/proc", directory.name, "stat"), "utf8"),
                );
            } catch {
                // Processes can exit while procfs is being enumerated.
            }
        }
    } catch {
        // A restricted Linux runtime may not mount procfs; the asynchronous fallback runs below.
    }
    return entries;
}

async function readLinuxProcessTableWithFallback(): Promise<readonly ProcessTableEntry[]> {
    const procfsEntries = await readLinuxProcessTable();
    if (procfsEntries.length > 0) {
        return procfsEntries;
    }
    for (const candidate of ["/usr/bin/ps", "/bin/ps", "/run/current-system/sw/bin/ps"]) {
        try {
            const resolvedPath = await realpath(candidate);
            if (!(await stat(resolvedPath)).isFile()) {
                continue;
            }
            await access(resolvedPath, constants.X_OK);
        } catch {
            continue;
        }
        const entries = await readProcessTableWithPs(candidate);
        if (entries.length > 0) {
            return entries;
        }
    }
    return [];
}

function processExists(processId: number): boolean {
    try {
        const encoded = readFileSync(join("/proc", processId.toString(), "stat"), "utf8");
        const closingParenthesis = encoded.lastIndexOf(")");
        if (closingParenthesis >= 0) {
            const processState = encoded
                .slice(closingParenthesis + 1)
                .trimStart()
                .charAt(0);
            if (processState === "Z" || processState === "X") {
                return false;
            }
        }
    } catch {
        // Fall through so restricted procfs mounts still use the portable signal probe.
    }
    return posixProcessExists(processId);
}

export const linuxPlatform: PlatformSupport = {
    ...posixOperations,
    readProcessTable: readLinuxProcessTableWithFallback,
    readProcessTableSynchronously: readLinuxProcessTableSynchronously,
    processExists,
    claudeCodeExecutablePaths: (environment) => {
        const homeDirectory = environment["HOME"];
        return homeDirectory !== undefined && isAbsolute(homeDirectory)
            ? [join(homeDirectory, ".local", "bin", "claude")]
            : [];
    },
};
