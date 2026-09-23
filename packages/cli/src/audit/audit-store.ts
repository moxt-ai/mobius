import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AuditRecord {
    readonly commandId: string;
    readonly details?: Readonly<Record<string, string>>;
    readonly event: string;
    readonly sessionId: string;
}

export class AuditStore {
    private readonly database: DatabaseSync;

    constructor(path: string) {
        mkdirSync(dirname(path), { recursive: true });
        this.database = new DatabaseSync(path);
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        event TEXT NOT NULL,
        command_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT
    `);
        const columns = this.database.prepare("PRAGMA table_info(audit_events)").all();
        if (!columns.some((column) => Reflect.get(column, "name") === "details_json")) {
            this.database.exec("ALTER TABLE audit_events ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}'");
        }
    }

    record(record: AuditRecord): void {
        this.database
            .prepare(
                `
          INSERT INTO audit_events (
            recorded_at,
            event,
            command_id,
            session_id,
            details_json
          ) VALUES (?, ?, ?, ?, ?)
        `,
            )
            .run(
                new Date().toISOString(),
                record.event,
                record.commandId,
                record.sessionId,
                JSON.stringify(record.details ?? {}),
            );
    }

    close(): void {
        this.database.close();
    }
}
