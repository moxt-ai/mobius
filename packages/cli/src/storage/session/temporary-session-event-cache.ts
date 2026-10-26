import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionEventCacheDatabase } from "../sqlite/local-databases.ts";
import { SessionEventCacheTable } from "./session-event-cache-table.ts";

/** The caller closes the table before removing its private temporary files. */
export function openTemporarySessionEventCache(): {
    readonly table: SessionEventCacheTable;
    readonly removeFiles: () => void;
} {
    const directory = mkdtempSync(join(tmpdir(), "mobius-preview-events-"));
    const removeFiles = (): void => rmSync(directory, { recursive: true, force: true });
    try {
        return {
            table: new SessionEventCacheTable(openSessionEventCacheDatabase(join(directory, "events.sqlite"))),
            removeFiles,
        };
    } catch (error) {
        removeFiles();
        throw error;
    }
}
