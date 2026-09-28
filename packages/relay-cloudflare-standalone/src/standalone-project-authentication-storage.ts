import { DatabaseError, relayDrizzle, type SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import { authenticationAuditEvent, projectBrowserCredential } from "@moxt-ai/mobius-relay-core/schema";
import { and, eq } from "drizzle-orm";

export interface StandaloneBrowserCredentialRecord {
    readonly credentialId: string;
    readonly expiresAt: number;
    readonly projectId: string;
    readonly revokedAt: number | null;
}

export interface StandaloneAuthorizationAudit {
    readonly actorId: string;
    readonly actorRef: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly outcome: "denied" | "succeeded";
    readonly projectId: string;
    readonly subjectId: string;
}

export class StandaloneProjectAuthenticationStorage {
    readonly #database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.#database = database;
    }

    readonly readBrowserCredential = async (
        projectId: string,
        tokenHash: string,
        signal: AbortSignal,
    ): Promise<StandaloneBrowserCredentialRecord | null> => {
        const rows = await relayDrizzle(this.#database, signal)
            .select({
                credentialId: projectBrowserCredential.credentialId,
                expiresAt: projectBrowserCredential.expiresAt,
                projectId: projectBrowserCredential.projectId,
                revokedAt: projectBrowserCredential.revokedAt,
            })
            .from(projectBrowserCredential)
            .where(
                and(
                    eq(projectBrowserCredential.projectId, projectId),
                    eq(projectBrowserCredential.tokenHash, tokenHash),
                ),
            )
            .limit(2);
        const record = rows[0];
        return rows.length === 1 && record !== undefined ? record : null;
    };

    readonly recordAuthorization = async (
        audit: StandaloneAuthorizationAudit,
        credentialId: string | null,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        const database = relayDrizzle(this.#database, signal);
        if (credentialId !== null) {
            const touched = await database
                .update(projectBrowserCredential)
                .set({ lastUsedAt: now })
                .where(
                    and(
                        eq(projectBrowserCredential.credentialId, credentialId),
                        eq(projectBrowserCredential.projectId, audit.projectId),
                    ),
                )
                .returning({ credentialId: projectBrowserCredential.credentialId });
            if (touched.length !== 1) {
                throw new DatabaseError(
                    "database_unavailable",
                    "The Standalone browser credential could not be recorded",
                );
            }
        }
        await database.insert(authenticationAuditEvent).values({
            action: "project.authorization",
            actorId: audit.actorId,
            actorKind: "browser_access",
            actorRef: audit.actorRef,
            auditId: `aau_${crypto.randomUUID()}`,
            detailsJson: JSON.stringify(audit.details),
            outcome: audit.outcome,
            projectId: audit.projectId,
            recordedAt: now,
            subjectId: audit.subjectId,
        });
    };
}
