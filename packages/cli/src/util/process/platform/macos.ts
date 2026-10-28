import type { ProcessPlatformSupport } from "./contracts.ts";
import { posixOperations, processExists, readProcessTableWithPs } from "./posix.ts";

export const macosProcessPlatform: ProcessPlatformSupport = {
    ...posixOperations,
    readProcessTable: () => readProcessTableWithPs("/bin/ps"),
    readProcessTableSynchronously: () => [],
    processExists,
};
