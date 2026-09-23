export interface AuditRecord {
    readonly commandId: string;
    readonly details?: Readonly<Record<string, string>>;
    readonly event: string;
    readonly sessionId: string;
}

const MAX_AUDIT_RECORDS = 1_024;

export class AuditStore {
    readonly #records: AuditRecord[] = [];

    readonly record = (record: AuditRecord): void => {
        if (this.#records.length === MAX_AUDIT_RECORDS) {
            this.#records.shift();
        }
        this.#records.push(
            record.details === undefined ? { ...record } : { ...record, details: { ...record.details } },
        );
    };

    readonly close = (): void => {
        this.#records.length = 0;
    };
}
