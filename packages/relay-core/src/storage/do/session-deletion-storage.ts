import type { DoSqlDatabase } from "../../infra/do-sql-database.ts";
export interface DeleteSessionRecords {
    readonly scopeKey: string;
    readonly sessionId: string;
}
export class SessionDeletionStorage {
    readonly rollbackImport = (input: DeleteSessionRecords): void => {
        this.#database.transaction(() => {
            this.deleteSessionContent(input);
            this.deleteSessions(input);
        });
    };

    private readonly deleteSessionContent = (input: DeleteSessionRecords): void => {
        this.deleteUploadedArtifacts(input);
        this.deleteArchiveWork(input);
        this.deleteArchiveSegments(input);
        this.deleteArtifacts(input);
        this.deleteToolCallViews(input);
        this.deletePendingWork(input);
        this.deleteInteractions(input);
        this.deleteSessionEvents(input);
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
                SET lifecycle = 'deleted', delete_completed_at = ?, native_history_json = NULL, updated_at = ?
                WHERE scope_key = ? AND session_id = ?`,
                [input.completedAt, input.completedAt, input.scopeKey, input.sessionId],
            );
        });
    };
    private readonly deleteUploadedArtifacts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM uploaded_artifacts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
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
    private readonly deleteSessionEvents = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM session_events WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteToolCallViews = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM tool_call_views WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteArtifacts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM artifacts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteArchiveSegments = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM archive_segments WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteArchiveWork = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM archive_work WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    private readonly deleteSessions = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM sessions WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
}
