import type { VerifiedExternalIdentity } from "@moxt-ai/mobius-relay-core";
import { PlatformControlPlaneError, type PlatformDeveloperAccess } from "../entity/platform-control-plane.ts";
import type { RecordingPolicyMode, ResolvedRecordingPolicy } from "../entity/recording-policy.ts";
import type { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";
import type { PlatformControlPlaneService } from "./platform-control-plane-service.ts";

export class RecordingPolicyService {
    readonly #control: PlatformControlPlaneService;
    readonly #providerAvailable: boolean;
    readonly #storage: RecordingPolicyStorage;

    constructor(control: PlatformControlPlaneService, storage: RecordingPolicyStorage, providerAvailable: boolean) {
        this.#control = control;
        this.#storage = storage;
        this.#providerAvailable = providerAvailable;
    }

    readonly readApp = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        await this.#control.requireAppDeveloper(identity, appId, signal);
        return this.resource(await this.requirePolicy(this.#storage.readApp(appId, signal)));
    };

    readonly readProject = async (
        identity: VerifiedExternalIdentity,
        projectId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        await this.authorizeProject(identity, projectId, signal);
        return this.resource(await this.requirePolicy(this.#storage.readProject(projectId, signal)));
    };

    readonly readProjectPolicy = async (projectId: string, signal: AbortSignal): Promise<ResolvedRecordingPolicy> =>
        await this.requirePolicy(this.#storage.readProject(projectId, signal));

    readonly writeApp = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        mode: RecordingPolicyMode,
        signal: AbortSignal,
    ): Promise<object> => {
        const { access } = await this.#control.requireAppDeveloper(identity, appId, signal);
        await this.#control.requireAdministrator(access, signal);
        this.requireProvider(mode);
        const now = Date.now();
        await this.#storage.writeApp(
            appId,
            mode,
            now,
            this.#control.developerAuditRecord(access, appId, appId, "app.recording-policy.updated", { mode }, now),
            signal,
        );
        return this.resource(await this.requirePolicy(this.#storage.readApp(appId, signal)));
    };

    readonly writeProject = async (
        identity: VerifiedExternalIdentity,
        projectId: string,
        mode: RecordingPolicyMode,
        signal: AbortSignal,
    ): Promise<object> => {
        const { access, appId } = await this.authorizeProject(identity, projectId, signal);
        await this.#control.requireAdministrator(access, signal);
        this.requireProvider(mode);
        const now = Date.now();
        await this.#storage.writeProject(
            projectId,
            mode,
            now,
            this.#control.developerAuditRecord(
                access,
                appId,
                projectId,
                "project.recording-policy.updated",
                { mode },
                now,
            ),
            signal,
        );
        return this.resource(await this.requirePolicy(this.#storage.readProject(projectId, signal)));
    };

    private readonly authorizeProject = async (
        identity: VerifiedExternalIdentity,
        projectId: string,
        signal: AbortSignal,
    ): Promise<{ readonly access: PlatformDeveloperAccess; readonly appId: string }> => {
        const target = await this.#storage.projectTarget(projectId, signal);
        if (target === null) {
            throw new PlatformControlPlaneError("project_not_found", "The Project is unavailable", 404);
        }
        const { access } = await this.#control.requireAppDeveloper(identity, target.appId, signal);
        return { access, appId: target.appId };
    };

    private readonly requirePolicy = async (
        policy: Promise<ResolvedRecordingPolicy | null>,
    ): Promise<ResolvedRecordingPolicy> => {
        const resolved = await policy;
        if (resolved === null) {
            throw new PlatformControlPlaneError(
                "recording_target_not_found",
                "The Recording policy target is unavailable",
                404,
            );
        }
        return resolved;
    };

    private readonly requireProvider = (mode: RecordingPolicyMode): void => {
        if (mode === "enabled" && !this.#providerAvailable) {
            throw new PlatformControlPlaneError(
                "recording_provider_unavailable",
                "Recording cannot be enabled because no Recording provider is installed",
                409,
            );
        }
    };

    private readonly resource = (policy: ResolvedRecordingPolicy): object => ({
        ...policy,
        providerAvailable: this.#providerAvailable,
    });
}
