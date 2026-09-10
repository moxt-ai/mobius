import type { SessionPromptCommand } from "@moxt-ai/mobius-protocol";
import {
    ARTIFACT_UPLOAD_LIFETIME_MILLISECONDS,
    ArtifactContent,
    type ArtifactDescriptor,
    ArtifactUploadAuthorization,
    ArtifactUploadLease,
    AvailableArtifactDescriptor,
    CreateArtifactUploadRequest,
    ExpiredArtifactDescriptor,
    type ProjectScope,
    type SessionExport,
    SessionRuntimeError,
    UploadingArtifactDescriptor,
} from "../../entity/do/session.ts";
import {
    ContentQuotaExceededError,
    ContentStorageError,
    ContentTarget,
    type ImmutableContentStore,
} from "../../infra/content-store.ts";
import type { DoSqlRow } from "../../infra/do-sql-database.ts";
import type { SessionArtifactStorage } from "../../storage/do/session-artifact-storage.ts";
import { rowNullableString, rowNumber, rowString } from "../../storage/do/sqlite-row.ts";
import { encodeBase64, sha256 } from "./session-archive-codec.ts";
import { IDENTIFIER_PATTERN, scopeKey } from "./session-records.ts";
import type { SessionStateService } from "./session-state-service.ts";

const MAX_ARTIFACT_NAME_LENGTH = 500;
const MAX_ARTIFACT_MEDIA_TYPE_LENGTH = 255;
const MAX_ARTIFACTS_PER_SESSION = 1_000;
const MAX_ARTIFACT_REFERENCES_PER_TURN = 16;
const CLEANUP_TIMEOUT_MILLISECONDS = 20_000;

function randomToken(byteLength: number): string {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function validateUploadRequest(request: CreateArtifactUploadRequest, maximumByteLength: number): void {
    if (
        request.name.length < 1 ||
        request.name.length > MAX_ARTIFACT_NAME_LENGTH ||
        request.name.includes("\0") ||
        request.mediaType.length < 1 ||
        request.mediaType.length > MAX_ARTIFACT_MEDIA_TYPE_LENGTH ||
        request.mediaType.includes("\r") ||
        request.mediaType.includes("\n") ||
        !Number.isSafeInteger(request.byteLength) ||
        request.byteLength < 1 ||
        request.byteLength > maximumByteLength ||
        !/^[a-f0-9]{64}$/.test(request.sha256)
    ) {
        throw new SessionRuntimeError("invalid_request", "The artifact upload request is invalid");
    }
}

function contentTarget(scope: ProjectScope, sessionId: string, targetId: string): ContentTarget {
    return new ContentTarget(scope.storageLocator.resolveHostingPlacement(), scope.projectId, sessionId, targetId);
}

function baseDescriptor(row: DoSqlRow): UploadingArtifactDescriptor {
    return new UploadingArtifactDescriptor(
        rowString(row, "session_id"),
        rowString(row, "artifact_id"),
        rowString(row, "file_name"),
        rowString(row, "media_type"),
        rowNumber(row, "byte_length"),
        rowString(row, "sha256"),
        new Date(rowNumber(row, "created_at")).toISOString(),
        new Date(rowNumber(row, "upload_expires_at")).toISOString(),
    );
}

function availableDescriptor(row: DoSqlRow): AvailableArtifactDescriptor {
    const availableAt = rowNullableString(row, "available_at");
    if (availableAt === null) {
        throw new SessionRuntimeError("session_storage_unavailable", "The artifact availability record is invalid");
    }
    return new AvailableArtifactDescriptor(
        rowString(row, "session_id"),
        rowString(row, "artifact_id"),
        rowString(row, "file_name"),
        rowString(row, "media_type"),
        rowNumber(row, "byte_length"),
        rowString(row, "sha256"),
        new Date(rowNumber(row, "created_at")).toISOString(),
        new Date(Number(availableAt)).toISOString(),
    );
}

function expiredDescriptor(row: DoSqlRow): ExpiredArtifactDescriptor {
    return new ExpiredArtifactDescriptor(
        rowString(row, "session_id"),
        rowString(row, "artifact_id"),
        rowString(row, "file_name"),
        rowString(row, "media_type"),
        rowNumber(row, "byte_length"),
        rowString(row, "sha256"),
        new Date(rowNumber(row, "created_at")).toISOString(),
        new Date(rowNumber(row, "upload_expires_at")).toISOString(),
    );
}

function translateContentFailure(error: unknown): never {
    if (error instanceof ContentQuotaExceededError) {
        throw new SessionRuntimeError("session_quota_exceeded", "The Session artifact quota is exhausted", {
            cause: error,
        });
    }
    if (error instanceof ContentStorageError) {
        throw new SessionRuntimeError(
            error.code === "content_storage_timeout" ? "session_storage_timeout" : "session_storage_unavailable",
            "The Session artifact content is unavailable",
            { cause: error },
        );
    }
    throw error;
}

export class SessionArtifactService {
    readonly #content: ImmutableContentStore;
    readonly #storage: SessionArtifactStorage;
    readonly #store: SessionStateService;

    constructor(cx: {
        readonly gateways: { readonly content: ImmutableContentStore };
        readonly storages: { readonly artifacts: SessionArtifactStorage };
        readonly services: { readonly state: SessionStateService };
    }) {
        const { content } = cx.gateways;
        const { state: store } = cx.services;
        this.#content = content;
        this.#storage = cx.storages.artifacts;
        this.#store = store;
    }

    readonly createUpload = async (
        scope: ProjectScope,
        sessionId: string,
        request: CreateArtifactUploadRequest,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadAuthorization> => {
        signal.throwIfAborted();
        const session = this.#store.requireActiveSessionRow(scope, sessionId, now);
        validateUploadRequest(request, rowNumber(session, "content_limit_bytes"));
        const existing = this.#storage.countArtifacts({ scopeKey: scopeKey(scope), sessionId: sessionId })[0];
        if (existing === undefined || rowNumber(existing, "artifact_count") >= MAX_ARTIFACTS_PER_SESSION) {
            throw new SessionRuntimeError("session_quota_exceeded", "The Session artifact count limit was reached");
        }
        const artifactId = `art_${randomToken(18)}`;
        const uploadToken = randomToken(32);
        const targetId = `upload-${artifactId}`;
        const expiresAt = now + ARTIFACT_UPLOAD_LIFETIME_MILLISECONDS;
        const result = this.#storage.insertUpload({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            artifactId: artifactId,
            fileName: request.name,
            mediaType: request.mediaType,
            byteLength: request.byteLength,
            sha256: request.sha256,
            contentTargetId: targetId,
            uploadTokenHash: await sha256(new TextEncoder().encode(uploadToken)),
            uploadExpiresAt: expiresAt,
            createdAt: now,
        });
        signal.throwIfAborted();
        if (result.changes !== 1) {
            throw new SessionRuntimeError(
                "session_storage_unavailable",
                "The artifact upload authorization was not stored",
            );
        }
        const descriptor = new UploadingArtifactDescriptor(
            sessionId,
            artifactId,
            request.name,
            request.mediaType,
            request.byteLength,
            request.sha256,
            new Date(now).toISOString(),
            new Date(expiresAt).toISOString(),
        );
        return new ArtifactUploadAuthorization(descriptor, uploadToken);
    };

    readonly authorizeUpload = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        uploadToken: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactUploadLease> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const row = this.requireRow(scope, sessionId, artifactId);
        if (rowString(row, "state") !== "uploading") {
            throw new SessionRuntimeError("artifact_upload_closed", "The artifact upload is no longer open");
        }
        if (rowNumber(row, "upload_expires_at") <= now) {
            this.#storage.expireUpload({ scopeKey: scopeKey(scope), sessionId: sessionId, artifactId: artifactId });
            throw new SessionRuntimeError("artifact_upload_expired", "The artifact upload authorization expired");
        }
        if (
            uploadToken.length < 32 ||
            uploadToken.length > 256 ||
            (await sha256(new TextEncoder().encode(uploadToken))) !== rowString(row, "upload_token_hash")
        ) {
            throw new SessionRuntimeError(
                "artifact_upload_unauthorized",
                "The artifact upload authorization is invalid",
            );
        }
        signal.throwIfAborted();
        return new ArtifactUploadLease(baseDescriptor(row), rowString(row, "content_target_id"));
    };

    readonly completeUpload = async (
        scope: ProjectScope,
        lease: ArtifactUploadLease,
        bytes: Uint8Array,
        now: number,
        signal: AbortSignal,
    ): Promise<AvailableArtifactDescriptor> => {
        signal.throwIfAborted();
        const artifact = lease.artifact;
        this.#store.requireActiveSessionRow(scope, artifact.sessionId, now);
        const row = this.requireRow(scope, artifact.sessionId, artifact.artifactId);
        if (
            rowString(row, "state") !== "uploading" ||
            rowString(row, "content_target_id") !== lease.contentTargetId ||
            rowNumber(row, "upload_expires_at") <= now ||
            bytes.byteLength !== artifact.byteLength ||
            bytes.byteLength !== rowNumber(row, "byte_length") ||
            artifact.sha256 !== rowString(row, "sha256") ||
            (await sha256(bytes)) !== artifact.sha256
        ) {
            throw new SessionRuntimeError(
                "artifact_content_mismatch",
                "The uploaded artifact does not match its authorization",
            );
        }
        const target = contentTarget(scope, artifact.sessionId, lease.contentTargetId);
        let contentWritten = false;
        try {
            await this.#content.write(
                target,
                {
                    bytes,
                    contentEncoding: "identity",
                    mediaType: artifact.mediaType,
                    sha256: artifact.sha256,
                },
                signal,
            );
            contentWritten = true;
            signal.throwIfAborted();
            this.#store.requireActiveSessionRow(scope, artifact.sessionId, now);
            const result = this.#storage.completeUpload({
                availableAt: now,
                scopeKey: scopeKey(scope),
                sessionId: artifact.sessionId,
                artifactId: artifact.artifactId,
                uploadExpiresAt: now,
            });
            if (result.changes !== 1) {
                const current = this.requireRow(scope, artifact.sessionId, artifact.artifactId);
                if (
                    rowString(current, "state") === "available" &&
                    rowString(current, "content_target_id") === lease.contentTargetId &&
                    rowNumber(current, "byte_length") === artifact.byteLength &&
                    rowString(current, "sha256") === artifact.sha256
                ) {
                    return availableDescriptor(current);
                }
                throw new SessionRuntimeError("artifact_upload_closed", "The artifact upload is no longer open");
            }
            return new AvailableArtifactDescriptor(
                artifact.sessionId,
                artifact.artifactId,
                artifact.name,
                artifact.mediaType,
                artifact.byteLength,
                artifact.sha256,
                artifact.createdAt,
                new Date(now).toISOString(),
            );
        } catch (error) {
            // A rejected completion cannot know whether another authorized request
            // published the same immutable target. Session lifecycle cleanup owns
            // deletion so a retry can never remove content that another request made
            // available.
            if (
                contentWritten &&
                error instanceof SessionRuntimeError &&
                (error.code === "session_deleted" || error.code === "session_not_found")
            ) {
                await this.#content
                    .delete(target, AbortSignal.timeout(CLEANUP_TIMEOUT_MILLISECONDS))
                    .catch(() => undefined);
            }
            translateContentFailure(error);
        }
    };

    readonly read = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        now: number,
        signal: AbortSignal,
    ): Promise<ArtifactDescriptor> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, now);
        const row = this.requireRow(scope, sessionId, artifactId);
        const state = rowString(row, "state");
        if (state === "available") {
            return availableDescriptor(row);
        }
        if (state === "uploading" && rowNumber(row, "upload_expires_at") <= now) {
            this.#storage.expireUpload({ scopeKey: scopeKey(scope), sessionId: sessionId, artifactId: artifactId });
            return expiredDescriptor(row);
        }
        if (state === "expired") {
            return expiredDescriptor(row);
        }
        return baseDescriptor(row);
    };

    readonly readContent = async (
        scope: ProjectScope,
        sessionId: string,
        artifactId: string,
        signal: AbortSignal,
    ): Promise<ArtifactContent> => {
        signal.throwIfAborted();
        this.#store.requireActiveSessionRow(scope, sessionId, Date.now());
        const row = this.requireRow(scope, sessionId, artifactId);
        if (rowString(row, "state") !== "available") {
            throw new SessionRuntimeError("artifact_not_ready", "The artifact content is not available");
        }
        try {
            const content = await this.#content.read(
                contentTarget(scope, sessionId, rowString(row, "content_target_id")),
                signal,
            );
            if (
                content.contentEncoding !== "identity" ||
                content.mediaType !== rowString(row, "media_type") ||
                content.bytes.byteLength !== rowNumber(row, "byte_length") ||
                content.sha256 !== rowString(row, "sha256") ||
                (await sha256(content.bytes)) !== content.sha256
            ) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The artifact failed integrity validation",
                );
            }
            return new ArtifactContent(availableDescriptor(row), content.bytes);
        } catch (error) {
            if (error instanceof SessionRuntimeError || signal.aborted) {
                throw error;
            }
            translateContentFailure(error);
        }
    };

    readonly resolveResources = async (
        scope: ProjectScope,
        sessionId: string,
        artifactIds: readonly string[],
        signal: AbortSignal,
    ): Promise<SessionPromptCommand["resources"]> => {
        signal.throwIfAborted();
        if (
            artifactIds.length > MAX_ARTIFACT_REFERENCES_PER_TURN ||
            new Set(artifactIds).size !== artifactIds.length ||
            artifactIds.some((artifactId) => !IDENTIFIER_PATTERN.test(artifactId))
        ) {
            throw new SessionRuntimeError("invalid_request", "The Turn artifact references are invalid");
        }
        const resources: SessionPromptCommand["resources"][number][] = [];
        for (const artifactId of artifactIds) {
            const row = this.requireRow(scope, sessionId, artifactId);
            if (rowString(row, "state") !== "available") {
                throw new SessionRuntimeError("artifact_not_ready", "A referenced artifact is not available");
            }
            const uri = new URL(`mobius-artifact:${artifactId}`);
            uri.searchParams.set("byteLength", rowNumber(row, "byte_length").toString());
            uri.searchParams.set("sha256", rowString(row, "sha256"));
            resources.push({
                mimeType: rowString(row, "media_type"),
                name: rowString(row, "file_name"),
                text: "",
                type: "link",
                uri: uri.toString(),
            });
        }
        signal.throwIfAborted();
        return resources;
    };

    readonly exportAvailable = async (
        scope: ProjectScope,
        sessionId: string,
        signal: AbortSignal,
    ): Promise<SessionExport["uploadedArtifacts"]> => {
        signal.throwIfAborted();
        const rows = this.#storage.listAvailableArtifactIds({ scopeKey: scopeKey(scope), sessionId: sessionId });
        const exported: SessionExport["uploadedArtifacts"][number][] = [];
        for (const row of rows) {
            const content = await this.readContent(scope, sessionId, rowString(row, "artifact_id"), signal);
            exported.push({
                artifactId: content.artifact.artifactId,
                availableAt: content.artifact.availableAt,
                byteLength: content.artifact.byteLength,
                contentBase64: encodeBase64(content.bytes),
                contentEncoding: "identity",
                createdAt: content.artifact.createdAt,
                mediaType: content.artifact.mediaType,
                name: content.artifact.name,
                sha256: content.artifact.sha256,
            });
        }
        return exported;
    };

    readonly restoreAvailable = async (
        scope: ProjectScope,
        sessionId: string,
        content: ArtifactContent,
        now: number,
        signal: AbortSignal,
    ): Promise<void> => {
        signal.throwIfAborted();
        const artifact = content.artifact;
        const session = this.#store.requireActiveSessionRow(scope, sessionId, now);
        const createdAt = Date.parse(artifact.createdAt);
        const availableAt = Date.parse(artifact.availableAt);
        validateUploadRequest(
            new CreateArtifactUploadRequest(artifact.name, artifact.mediaType, artifact.byteLength, artifact.sha256),
            rowNumber(session, "content_limit_bytes"),
        );
        if (
            artifact.sessionId !== sessionId ||
            !IDENTIFIER_PATTERN.test(artifact.artifactId) ||
            !Number.isSafeInteger(createdAt) ||
            createdAt < 0 ||
            !Number.isSafeInteger(availableAt) ||
            availableAt < createdAt ||
            content.bytes.byteLength !== artifact.byteLength ||
            (await sha256(content.bytes)) !== artifact.sha256
        ) {
            throw new SessionRuntimeError("invalid_export", "An uploaded export artifact is invalid");
        }
        const targetId = `upload-${artifact.artifactId}`;
        const target = contentTarget(scope, sessionId, targetId);
        let stored = false;
        try {
            await this.#content.write(
                target,
                {
                    bytes: content.bytes,
                    contentEncoding: "identity",
                    mediaType: artifact.mediaType,
                    sha256: artifact.sha256,
                },
                signal,
            );
            stored = true;
            signal.throwIfAborted();
            const result = this.#storage.insertAvailableArtifact({
                scopeKey: scopeKey(scope),
                sessionId: sessionId,
                artifactId: artifact.artifactId,
                fileName: artifact.name,
                mediaType: artifact.mediaType,
                byteLength: artifact.byteLength,
                sha256: artifact.sha256,
                contentTargetId: targetId,
                uploadExpiresAt: availableAt,
                createdAt: createdAt,
                availableAt: availableAt,
            });
            if (result.changes !== 1) {
                throw new SessionRuntimeError(
                    "session_storage_unavailable",
                    "The uploaded export artifact was not restored",
                );
            }
        } catch (error) {
            if (stored) {
                await this.#content
                    .delete(target, AbortSignal.timeout(CLEANUP_TIMEOUT_MILLISECONDS))
                    .catch(() => undefined);
            }
            if (error instanceof SessionRuntimeError || signal.aborted) {
                throw error;
            }
            translateContentFailure(error);
        }
    };

    private readonly requireRow = (scope: ProjectScope, sessionId: string, artifactId: string): DoSqlRow => {
        if (!IDENTIFIER_PATTERN.test(artifactId)) {
            throw new SessionRuntimeError("artifact_not_found", "The artifact does not exist");
        }
        const row = this.#storage.findArtifact({
            scopeKey: scopeKey(scope),
            sessionId: sessionId,
            artifactId: artifactId,
        });
        if (row === undefined) {
            throw new SessionRuntimeError("artifact_not_found", "The artifact does not exist");
        }
        return row;
    };
}
