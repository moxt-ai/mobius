import { RuntimeAccessContext } from "../../entity/authentication/project-authentication.ts";
import { ProjectScope } from "../../entity/do/session.ts";
import { PairingDirectoryError, validateIdentifier } from "../../entity/pairing/pairing.ts";
import type { PairingIdentityCredential } from "../../entity/pairing/pairing-identity.ts";
import type { PairingScopeRow } from "../../entity/pairing/pairing-records.ts";
import type { ProjectStorageContext, ProjectStorageDirectory } from "../../infra/project-storage-directory.ts";
import type { ProjectStore, ProjectStoreResolver } from "../../infra/project-store.ts";
import { DatabaseError } from "../../infra/sql-database.ts";

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

/**
 * Finds the Project a credential belongs to by asking the Project stores this execution can search, then confirms
 * that the Relay still serves that Project from the store that matched.
 */
export class PairingIdentityService {
    readonly #sources: readonly ProjectStore[];
    readonly #stores: ProjectStoreResolver;
    readonly #projects: ProjectStorageDirectory;
    constructor(sources: readonly ProjectStore[], stores: ProjectStoreResolver, projects: ProjectStorageDirectory) {
        this.#sources = [...sources];
        this.#stores = stores;
        this.#projects = projects;
    }

    private readonly matchesPlacement = (source: ProjectStore, project: ProjectStorageContext): boolean =>
        source === this.#stores.resolve(project.storagePlacement);

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
        if (!this.matchesPlacement(identity.source, project)) {
            throw new PairingDirectoryError("directory_unavailable", "Workspace storage is unavailable");
        }
        return project;
    };

    readonly authenticateRuntime = async (tokenHash: string, signal: AbortSignal): Promise<RuntimeAccessContext> => {
        signal.throwIfAborted();
        try {
            const matches: { readonly source: ProjectStore; readonly row: PairingScopeRow }[] = [];
            for (const source of this.#sources) {
                for (const row of await source.findRuntimeCredential(tokenHash, signal)) {
                    matches.push({ source, row });
                }
            }
            const match = matches[0];
            if (matches.length !== 1 || match === undefined) {
                throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
            }
            const projectId = validateIdentifier(match.row.project_id, "project_id");
            const runtimeId = validateIdentifier(match.row.runtime_id, "runtime_id");
            const channelId = validateIdentifier(match.row.channel_id, "channel_id");
            const project = await this.#projects.resolve(projectId, signal);
            signal.throwIfAborted();
            if (project === null) {
                throw new PairingDirectoryError("unauthorized", "A valid Runtime credential is required");
            }
            if (!this.matchesPlacement(match.source, project)) {
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
            const matches: { readonly projectId: string; readonly source: ProjectStore }[] = [];
            for (const source of this.#sources) {
                for (const row of await source.findCredential(credential, signal)) {
                    signal.throwIfAborted();
                    if (credential.kind === "project") {
                        if (
                            (row.revoked_at !== null && !Number.isSafeInteger(row.revoked_at)) ||
                            (row.expires_at !== null && !Number.isSafeInteger(row.expires_at))
                        ) {
                            throw new PairingDirectoryError(
                                "invalid_directory_record",
                                "The Project directory is invalid",
                            );
                        }
                        if (row.revoked_at !== null) {
                            throw new PairingDirectoryError("credential_revoked", "The browser credential was revoked");
                        }
                        if (row.expires_at !== null && row.expires_at <= Date.now()) {
                            throw new PairingDirectoryError("credential_expired", "The browser credential expired");
                        }
                    }
                    matches.push({ projectId: validateIdentifier(row.project_id, "project_id"), source });
                }
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
