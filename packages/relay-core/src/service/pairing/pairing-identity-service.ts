import { RuntimeAccessContext } from "../../entity/authentication/project-authentication.ts";
import { ProjectScope } from "../../entity/do/session.ts";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import { DatabaseError } from "../../infra/sql-database.ts";
import type { PairingIdentityStorage } from "../../storage/pairing-identity-storage.ts";

function runtimeIdentityField(row: Readonly<Record<string, unknown>>, name: string): string {
    const value = row[name];
    if (typeof value !== "string") {
        throw new PairingDirectoryError("invalid_directory_record", "The Runtime directory is invalid");
    }
    return validateIdentifier(value, name);
}

/** A credential that matches nothing, including one stored for a Project that is no longer served. */
function unmatchedCredential(credential: PairingIdentityCredential): PairingDirectoryError {
    const code =
        credential.kind === "pairing"
            ? "pairing_not_found"
            : credential.kind === "pairing-code"
              ? "invalid_pairing_code"
              : credential.kind === "grant"
                ? "access_grant_invalid"
                : "unauthorized";
    return new PairingDirectoryError(code, "A valid pairing or channel credential is required");
}

export class PairingIdentityService {
    readonly #storage: PairingIdentityStorage;
    readonly #projects: ProjectStorageDirectory;
    constructor(storage: PairingIdentityStorage, projects: ProjectStorageDirectory) {
        this.#storage = storage;
        this.#projects = projects;
    }

    readonly authenticateProject = async (
        credential: PairingIdentityCredential,
        signal: AbortSignal,
    ): Promise<ProjectStorageContext> => {
        const identity = await this.authenticate(credential, signal);
        const project = await this.#projects.resolve(identity.projectId, signal);
        signal.throwIfAborted();
        if (project === null) {
            throw unmatchedCredential(credential);
        }
        if (!this.#storage.matchesPlacement(identity.sourceId, project)) {
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable");
        }
        return project;
    };

    readonly authenticateRuntime = async (tokenHash: string, signal: AbortSignal): Promise<RuntimeAccessContext> => {
        signal.throwIfAborted();
        try {
            const matches = await this.#storage.findRuntime(tokenHash, signal);
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) {
                throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
            }
            const projectId = runtimeIdentityField(match.row, "project_id");
            const runtimeId = runtimeIdentityField(match.row, "runtime_id");
            const channelId = runtimeIdentityField(match.row, "channel_id");
            const project = await this.#projects.resolve(projectId, signal);
            signal.throwIfAborted();
            if (project === null) {
                throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
            }
            if (!this.#storage.matchesPlacement(match.sourceId, project)) {
                throw new PairingDirectoryError("directory_unavailable", "Runtime storage is unavailable");
            }
            return new RuntimeAccessContext(new ProjectScope(projectId), runtimeId, channelId, `daemon:${channelId}`);
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            if (cause instanceof DatabaseError && cause.code === "database_timeout") {
                throw new PairingDirectoryError("directory_timeout", "The Runtime directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Runtime directory is unavailable", {
                cause,
            });
        }
    };

    private readonly authenticate = async (credential: PairingIdentityCredential, signal: AbortSignal) => {
        signal.throwIfAborted();
        try {
            const matches: { readonly projectId: string; readonly sourceId: string }[] = [];
            for (const { row, sourceId } of await this.#storage.find(credential, signal)) {
                signal.throwIfAborted();
                const projectId = row["project_id"];
                if (typeof projectId !== "string") {
                    throw new PairingDirectoryError("invalid_directory_record", "The Project directory is invalid");
                }
                if (credential.kind === "project") {
                    const revokedAt = row["revoked_at"];
                    const expiresAt = row["expires_at"];
                    if (
                        (revokedAt !== null && (typeof revokedAt !== "number" || !Number.isSafeInteger(revokedAt))) ||
                        (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)))
                    ) {
                        throw new PairingDirectoryError("invalid_directory_record", "The Project directory is invalid");
                    }
                    if (revokedAt !== null) {
                        throw new PairingDirectoryError("credential_revoked", "The browser credential was revoked");
                    }
                    if (expiresAt !== null && expiresAt <= Date.now()) {
                        throw new PairingDirectoryError("credential_expired", "The browser credential expired");
                    }
                }
                matches.push({ projectId: validateIdentifier(projectId, "project_id"), sourceId });
            }
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) {
                throw unmatchedCredential(credential);
            }
            return match;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof PairingDirectoryError) {
                throw cause;
            }
            if (cause instanceof DatabaseError && cause.code === "database_timeout") {
                throw new PairingDirectoryError("directory_timeout", "The Project directory timed out", { cause });
            }
            throw new PairingDirectoryError("directory_unavailable", "The Project directory is unavailable", { cause });
        }
    };
}
