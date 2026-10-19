import { ProjectAuthenticationError, ProjectPermission } from "@moxt-ai/mobius-relay-core";
import {
    decodeSessionAccessCredential,
    isIdentifier,
    issueSessionAccessCredential,
    verifySessionAccessCredential,
} from "@moxt-ai/mobius-sdk/protocol";
import type { AppCredentialAuthenticationService } from "./app-credential-authentication-service.ts";
import type { PlatformControlPlaneService } from "./platform-control-plane-service.ts";

export type SessionAccessTarget =
    | { readonly kind: "session"; readonly projectId: string; readonly sessionId: string }
    | { readonly kind: "unavailable" };

export class SessionAccessService {
    readonly #applications: AppCredentialAuthenticationService;
    readonly #control: PlatformControlPlaneService;

    constructor(applications: AppCredentialAuthenticationService, control: PlatformControlPlaneService) {
        this.#applications = applications;
        this.#control = control;
    }

    readonly issue = async (
        target: SessionAccessTarget,
        runtimeId: string,
        appCredential: string,
        expiresInSeconds: number,
        signal: AbortSignal,
    ): Promise<{
        readonly credential: string;
        readonly credentialId: string;
        readonly expiresAt: string;
        readonly projectId: string;
        readonly sessionId: string;
    }> => {
        if (target.kind !== "session") {
            throw new ProjectAuthenticationError("project_permission_denied", "A selected Session is required");
        }
        if (!isIdentifier(runtimeId)) {
            throw new ProjectAuthenticationError("invalid_request", "The Runtime identifier is invalid");
        }
        if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 900) {
            throw new ProjectAuthenticationError("invalid_request", "The Session credential lifetime is invalid");
        }
        await this.#control.authorizePlatformCredential(
            target.projectId,
            appCredential,
            ProjectPermission.SessionWrite,
            "",
            signal,
        );
        const issuedAtEpochMilliseconds = Date.now();
        const expiresAtEpochMilliseconds = issuedAtEpochMilliseconds + expiresInSeconds * 1_000;
        const credential = await issueSessionAccessCredential(appCredential, {
            expiresAtEpochMilliseconds,
            issuedAtEpochMilliseconds,
            projectId: target.projectId,
            purpose: "session-access",
            runtimeId,
            sessionId: target.sessionId,
        });
        return {
            credential,
            credentialId: `sac_${crypto.randomUUID()}`,
            expiresAt: new Date(expiresAtEpochMilliseconds).toISOString(),
            projectId: target.projectId,
            sessionId: target.sessionId,
        };
    };

    readonly authorizeLiveEvents = async (target: SessionAccessTarget, credentialValue: string, signal: AbortSignal) =>
        await this.authorizeSession(target, credentialValue, ProjectPermission.SessionRead, signal);

    readonly authorizeSession = async (
        target: SessionAccessTarget,
        credentialValue: string,
        permission: ProjectPermission,
        signal: AbortSignal,
    ): Promise<{
        readonly expiresAtEpochMilliseconds: number;
        readonly projectId: string;
        readonly runtimeId: string;
    }> => {
        if (target.kind !== "session") {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential authorizes only a selected Session",
            );
        }
        let decoded: ReturnType<typeof decodeSessionAccessCredential>;
        try {
            decoded = decodeSessionAccessCredential(credentialValue);
        } catch (cause) {
            throw new ProjectAuthenticationError("project_credential_invalid", "The Session credential is invalid", {
                cause,
            });
        }
        const application = await this.#applications.readActiveCredentialByPublicId(decoded.publicCredentialId, signal);
        let claims: Awaited<ReturnType<typeof verifySessionAccessCredential>>;
        try {
            claims = await verifySessionAccessCredential(credentialValue, application.secret_digest, Date.now());
        } catch (cause) {
            throw new ProjectAuthenticationError("credential_expired", "The Session credential is unavailable", {
                cause,
            });
        }
        if (claims.projectId !== target.projectId || claims.sessionId !== target.sessionId) {
            throw new ProjectAuthenticationError(
                "project_permission_denied",
                "The credential authorizes only the selected Session",
            );
        }
        await this.#control.authorizePlatformCredentialRecord(target.projectId, application, permission, signal);
        return {
            expiresAtEpochMilliseconds: claims.expiresAtEpochMilliseconds,
            projectId: claims.projectId,
            runtimeId: claims.runtimeId,
        };
    };
}
