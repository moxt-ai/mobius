import type { SessionSqlDatabase } from "./session-sql-database.ts";
export interface DeleteSessionRecords {
    readonly scopeKey: string;
    readonly sessionId: string;
}
export class SessionDeletionStorage {
    readonly deleteUploadedArtifacts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM uploaded_artifacts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly #database: SessionSqlDatabase;
    constructor(cx: { readonly gateways: { readonly database: SessionSqlDatabase } }) {
        const { database } = cx.gateways;
        this.#database = database;
    }
    readonly deleteSessionBindings = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM session_bindings WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteTurns = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM turns WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteCommandReceipts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM command_receipts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteAttempts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM attempts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteInteractions = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM interactions WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deletePendingWork = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM pending_work WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteSessionEvents = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM session_events WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteToolCallViews = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM tool_call_views WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteArtifacts = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM artifacts WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteArchiveSegments = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM archive_segments WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteArchiveWork = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM archive_work WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
    readonly deleteSessions = (input: DeleteSessionRecords): { readonly changes: number } =>
        this.#database.run("DELETE FROM sessions WHERE scope_key = ? AND session_id = ?", [
            input.scopeKey,
            input.sessionId,
        ]);
}
