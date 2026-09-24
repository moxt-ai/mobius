import { decodeSessionAccessCredential, verifySessionAccessCredential } from "@moxt-ai/mobius-protocol";
import { ProjectAuthenticationError, ProjectPermission } from "@moxt-ai/mobius-relay-core";
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

    readonly authorizeLiveEvents = async (
        target: SessionAccessTarget,
        credentialValue: string,
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
        await this.#control.authorizePlatformCredentialRecord(
            target.projectId,
            application,
            ProjectPermission.SessionRead,
            signal,
        );
        return {
            expiresAtEpochMilliseconds: claims.expiresAtEpochMilliseconds,
            projectId: claims.projectId,
            runtimeId: claims.runtimeId,
        };
    };
}
