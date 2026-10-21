import type { Logger } from "drizzle-orm/logger";

/** Counts executed SQL statements, not Cloudflare billed rows or physical index writes. */
export class RecordingSqlMetrics implements Logger {
    #reads = 0;
    #writes = 0;

    readonly logQuery = (query: string, _parameters: unknown[]): void => {
        const operation = query.trimStart().split(" ", 1)[0]?.toLowerCase();
        if (operation === "select") {
            this.#reads += 1;
        }
        if (operation === "insert" || operation === "update" || operation === "delete") {
            this.#writes += 1;
        }
    };

    readonly snapshot = (): { readonly reads: number; readonly writes: number } => ({
        reads: this.#reads,
        writes: this.#writes,
    });
}
