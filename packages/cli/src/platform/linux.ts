import { constants, readdirSync, readFileSync } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformSupport, ProcessTableEntry } from "./contracts.ts";
import { processExists as posixProcessExists, readProcessTableWithPs } from "./posix.ts";

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
    readProcessTable: readLinuxProcessTableWithFallback,
    readProcessTableSynchronously: readLinuxProcessTableSynchronously,
    processExists,
    workBuddyExecutablePaths: () => [],
    openCodeArchives: {
        arm64: {
            asset: "opencode-linux-arm64.tar.gz",
            sha256: "70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0",
            format: "tar.gz",
        },
        x64: {
            asset: "opencode-linux-x64.tar.gz",
            sha256: "ea800b7ff56226b70952126c9fc1e2517ca4c4b5682fd9d3f9e87449697a1194",
            format: "tar.gz",
        },
    },
    grokDependencies: {
        arm64: {
            name: "@xai-official/grok-linux-arm64",
            integrity:
                "sha512-Jlwz9XtZPNKz/V/ydifC8OVu3hIZz7pmoStt8c4KCqkSWjWiZ/PBIC0iJiq8rvByhx5Z0EdSyq8ZXVwtocceGA==",
            tarballUrl: "https://registry.npmjs.org/@xai-official/grok-linux-arm64/-/grok-linux-arm64-1.0.21.tgz",
        },
        x64: {
            name: "@xai-official/grok-linux-x64",
            integrity:
                "sha512-AjDV5ifEz5LFG2Jt5IlhAeEkJati/wOvCchVbR4eIj2ogjvmXoXlzBrYRXuAJpXBy5q0se/Yuez5FxDU9Ju81w==",
            tarballUrl: "https://registry.npmjs.org/@xai-official/grok-linux-x64/-/grok-linux-x64-1.0.21.tgz",
        },
    },
};
