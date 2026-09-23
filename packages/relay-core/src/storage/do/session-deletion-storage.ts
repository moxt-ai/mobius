import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
export interface DeleteSessionRecords {
    readonly scopeKey: string;
    readonly sessionId: string;
}
export class SessionDeletionStorage {
    private readonly deleteSessionContent = (input: DeleteSessionRecords): void => {
        this.deletePendingWork(input);
        this.deleteInteractions(input);
        this.deleteSessionEventReceipts(input);
        this.deleteAttempts(input);
        this.deleteCommandReceipts(input);
        this.deleteTurns(input);
        this.deleteSessionBindings(input);
    };

    readonly completeDeletion = (input: DeleteSessionRecords & { readonly completedAt: number }): void => {
        this.#database.transaction(() => {
            this.deleteSessionContent(input);
            this.#database.run(
                `UPDATE sessions
                SET lifecycle = 'deleted', delete_completed_at = ?, updated_at = ?
                WHERE scope_key = ? AND session_id = ?`,
                [input.completedAt, input.completedAt, input.scopeKey, input.sessionId],
            );
        });
    };
    readonly #database: DoSqlDatabase;
    constructor(cx: { readonly doDatabase: DoSqlDatabase }) {
        const { doDatabase: database } = cx;
        this.#database = database;
    }
    private readonly deleteSessionBindings = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM session_bindings WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteTurns = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM turns WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteCommandReceipts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM command_receipts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteAttempts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM attempts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteInteractions = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM interactions WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deletePendingWork = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM pending_work WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteSessionEventReceipts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM session_event_receipts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
}
