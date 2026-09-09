import { PairingDirectoryError, validateIdentifier } from "@moxt-ai/mobius-relay-core";

export type PairingIdentityCredential =
    | { readonly kind: "host"; readonly channelId: string; readonly tokenHash: string }
    | { readonly kind: "daemon"; readonly channelId: string; readonly tokenHash: string }
    | { readonly kind: "project"; readonly projectId: string; readonly tokenHash: string }
    | { readonly kind: "pairing"; readonly pairingId: string; readonly tokenHash: string }
    | { readonly kind: "pairing-code"; readonly codeHash: string }
    | { readonly kind: "grant"; readonly channelId: string; readonly grantId: string; readonly secretHash: string };

export interface PairingIdentityDirectory {
    readonly authenticate: (
        credential: PairingIdentityCredential,
        signal: AbortSignal,
    ) => Promise<{
        readonly tenantId: string;
        readonly database: D1Database;
    }>;
}

function identityStatement(database: D1Database, credential: PairingIdentityCredential): D1PreparedStatement {
    switch (credential.kind) {
        case "host":
            return database
                .prepare(`SELECT DISTINCT channels.tenant_id FROM pairing_channels AS channels
                INNER JOIN channel_host_credentials AS credentials ON credentials.channel_id = channels.channel_id
                WHERE channels.channel_id = ? AND credentials.token_hash = ?
                AND credentials.revoked_at IS NULL AND channels.status = 'paired'`)
                .bind(validateIdentifier(credential.channelId, "channel_id"), credential.tokenHash);
        case "daemon":
            return database
                .prepare(`SELECT tenant_id FROM pairing_channels
                WHERE channel_id = ? AND daemon_token_hash = ? AND status = 'paired'`)
                .bind(validateIdentifier(credential.channelId, "channel_id"), credential.tokenHash);
        case "project":
            return database
                .prepare(`SELECT tenant_id, NULL AS expires_at, revoked_at FROM project_owner_credentials
                WHERE project_id = ? AND token_hash = ?
                UNION SELECT DISTINCT channels.tenant_id, NULL AS expires_at, NULL AS revoked_at FROM pairing_channels AS channels
                INNER JOIN channel_host_credentials AS credentials ON credentials.channel_id = channels.channel_id
                WHERE channels.project_id = ? AND credentials.token_hash = ?
                AND credentials.revoked_at IS NULL AND channels.status = 'paired'
                UNION SELECT tenant_id, expires_at, revoked_at FROM project_browser_credentials WHERE project_id = ? AND token_hash = ?`)
                .bind(
                    validateIdentifier(credential.projectId, "project_id"),
                    credential.tokenHash,
                    credential.projectId,
                    credential.tokenHash,
                    credential.projectId,
                    credential.tokenHash,
                );
        case "pairing":
            return database
                .prepare("SELECT tenant_id FROM pairing_channels WHERE pairing_id = ? AND poll_token_hash = ?")
                .bind(validateIdentifier(credential.pairingId, "pairing_id"), credential.tokenHash);
        case "pairing-code":
            return database
                .prepare("SELECT tenant_id FROM pairing_channels WHERE pairing_code_hash = ?")
                .bind(credential.codeHash);
        case "grant":
            return database
                .prepare(`SELECT channels.tenant_id FROM channel_access_grants AS grants
                INNER JOIN pairing_channels AS channels ON channels.channel_id = grants.channel_id
                WHERE grants.channel_id = ? AND grants.grant_id = ? AND grants.secret_hash = ?`)
                .bind(
                    validateIdentifier(credential.channelId, "channel_id"),
                    validateIdentifier(credential.grantId, "grant_id"),
                    credential.secretHash,
                );
    }
}

function readIdentityRows(
    statement: D1PreparedStatement,
    signal: AbortSignal,
): Promise<D1Result<Record<string, unknown>>> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
        };
        const abort = () => {
            cleanup();
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new PairingDirectoryError("directory_timeout", "The tenant directory timed out"));
        }, 15_000);
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve()
            .then(() => {
                signal.throwIfAborted();
                return statement.all<Record<string, unknown>>();
            })
            .then(
                (result) => {
                    cleanup();
                    resolve(result);
                },
                (cause: unknown) => {
                    cleanup();
                    reject(cause);
                },
            );
    });
}

export class D1PairingIdentityDirectory implements PairingIdentityDirectory {
    readonly #databases: readonly D1Database[];

    constructor(databases: readonly D1Database[]) {
        this.#databases = databases;
    }

    readonly authenticate: PairingIdentityDirectory["authenticate"] = async (credential, signal) => {
        signal.throwIfAborted();
        const matches: { readonly tenantId: string; readonly database: D1Database }[] = [];
        try {
            for (const database of this.#databases) {
                const rows = await readIdentityRows(identityStatement(database, credential), signal);
                signal.throwIfAborted();
                for (const row of rows.results) {
                    const tenantId = row["tenant_id"];
                    if (typeof tenantId !== "string") {
                        throw new PairingDirectoryError("invalid_directory_record", "The tenant directory is invalid");
                    }
                    if (credential.kind === "project") {
                        const revokedAt = row["revoked_at"];
                        const expiresAt = row["expires_at"];
                        if (
                            (revokedAt !== null &&
                                (typeof revokedAt !== "number" || !Number.isSafeInteger(revokedAt))) ||
                            (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)))
                        ) {
                            throw new PairingDirectoryError(
                                "invalid_directory_record",
                                "The tenant directory is invalid",
                            );
                        }
                        if (revokedAt !== null) {
                            throw new PairingDirectoryError("credential_revoked", "The browser credential was revoked");
                        }
                        if (expiresAt !== null && expiresAt <= Date.now()) {
                            throw new PairingDirectoryError("credential_expired", "The browser credential expired");
                        }
                    }
                    matches.push({ tenantId: validateIdentifier(tenantId, "tenant_id"), database });
                }
            }
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) {
                const code =
                    credential.kind === "pairing"
                        ? "pairing_not_found"
                        : credential.kind === "pairing-code"
                          ? "invalid_pairing_code"
                          : credential.kind === "grant"
                            ? "access_grant_invalid"
                            : "unauthorized";
                throw new PairingDirectoryError(code, "A valid pairing or channel credential is required");
            }
            return match;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            throw new PairingDirectoryError("directory_unavailable", "The tenant directory is unavailable", { cause });
        }
    };
}
