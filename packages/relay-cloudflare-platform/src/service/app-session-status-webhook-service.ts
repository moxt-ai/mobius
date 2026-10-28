import { createRandomToken, type VerifiedExternalIdentity } from "@moxt-ai/mobius-relay-core";
import type { StoredAppSessionStatusWebhook } from "../entity/app-session-status-webhook.ts";
import { PlatformControlPlaneError, type PlatformDeveloperAccess } from "../entity/platform-control-plane.ts";
import type { PlatformAuditRecord } from "../entity/platform-records.ts";
import type { AppSessionStatusWebhookStorage } from "../storage/app-session-status-webhook-storage.ts";
import {
    decryptWebhookSecret,
    encryptWebhookSecret,
    parseWebhookEncryptionKey,
} from "./app-session-status-webhook-crypto.ts";
import type { PlatformControlPlaneService } from "./platform-control-plane-service.ts";

export class AppSessionStatusWebhookService {
    readonly #control: PlatformControlPlaneService | null;
    readonly #encryptionKey: ArrayBuffer;
    readonly #storage: AppSessionStatusWebhookStorage;

    constructor(
        control: PlatformControlPlaneService | null,
        storage: AppSessionStatusWebhookStorage,
        encryptionKey: string | undefined,
    ) {
        if (encryptionKey === undefined) {
            throw new Error("MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY is required");
        }
        this.#control = control;
        this.#encryptionKey = parseWebhookEncryptionKey(encryptionKey);
        this.#storage = storage;
    }

    readonly read = async (identity: VerifiedExternalIdentity, appId: string, signal: AbortSignal): Promise<object> => {
        const { current } = await this.#authorized(identity, appId, signal);
        return current === null
            ? { appId, configured: false, enabled: false, endpoint: "", secretId: "" }
            : this.resource(current);
    };

    readonly write = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        enabled: boolean,
        endpoint: string,
        signal: AbortSignal,
    ): Promise<object> => {
        const { access, current } = await this.#authorized(identity, appId, signal);
        const normalizedEndpoint = httpsEndpoint(endpoint);
        const now = Date.now();
        const configured = (created: boolean) =>
            this.#audit(access, appId, "app.session-status-webhook.configured", { created, enabled }, now);
        if (current === null) {
            const secret = await this.#newSecret();
            const created = await this.#storage.create(
                {
                    appId,
                    enabled,
                    endpoint: normalizedEndpoint,
                    secretCiphertext: secret.ciphertext,
                    secretId: secret.secretId,
                    secretNonce: secret.nonce,
                },
                now,
                configured(true),
            );
            // A committed secret is returned even if the request is cancelled now; it is shown only once.
            if (created.kind === "app-unavailable") {
                throw appUnavailable();
            }
            if (created.kind !== "conflict") {
                return { ...this.resource(created.webhook), secret: secret.plaintext };
            }
        }
        const stored = await this.#storage.updateSettings(appId, enabled, normalizedEndpoint, now, configured(false));
        if (stored.kind === "app-unavailable") {
            throw appUnavailable();
        }
        if (stored.kind === "conflict") {
            throw new Error("The App Session status webhook could not be stored");
        }
        return this.resource(stored.webhook);
    };

    readonly rotate = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        const { access, current } = await this.#authorized(identity, appId, signal);
        if (current === null) {
            throw new PlatformControlPlaneError("webhook_not_found", "The App webhook is not configured", 404);
        }
        const secret = await this.#newSecret();
        const now = Date.now();
        const stored = await this.#storage.rotateSecret(
            appId,
            current.secretId,
            { secretCiphertext: secret.ciphertext, secretId: secret.secretId, secretNonce: secret.nonce },
            now,
            this.#audit(access, appId, "app.session-status-webhook.secret-rotated", {}, now),
        );
        if (stored.kind === "app-unavailable") {
            throw appUnavailable();
        }
        if (stored.kind === "conflict") {
            throw new PlatformControlPlaneError(
                "webhook_rotation_conflict",
                "The App webhook secret was rotated by another request",
                409,
            );
        }
        // A committed secret is returned even if the request is cancelled now; it is shown only once.
        return { ...this.resource(stored.webhook), secret: secret.plaintext };
    };

    readonly decryptSecret = async (webhook: StoredAppSessionStatusWebhook): Promise<string> =>
        await decryptWebhookSecret(webhook.secretCiphertext, webhook.secretNonce, this.#encryptionKey);

    readonly #authorized = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        signal: AbortSignal,
    ): Promise<{
        readonly access: PlatformDeveloperAccess;
        readonly current: StoredAppSessionStatusWebhook | null;
    }> => {
        const { access } = await this.#controlPlane().requireAppDeveloper(identity, appId, signal);
        return { access, current: await this.#storage.read(appId) };
    };

    readonly #controlPlane = (): PlatformControlPlaneService => {
        if (this.#control === null) {
            throw new Error("The App Session status webhook service is not configured for dashboard access");
        }
        return this.#control;
    };

    /** Endpoint URLs and secrets stay out of the audit trail; only safe change metadata is recorded. */
    readonly #audit = (
        access: PlatformDeveloperAccess,
        appId: string,
        action: string,
        details: Readonly<Record<string, unknown>>,
        now: number,
    ): PlatformAuditRecord => this.#controlPlane().developerAuditRecord(access, appId, appId, action, details, now);

    readonly #newSecret = async () => {
        const secretId = createRandomToken(12);
        const plaintext = `mweb_${secretId}_${createRandomToken(32)}`;
        return { plaintext, secretId, ...(await encryptWebhookSecret(plaintext, this.#encryptionKey)) };
    };

    readonly resource = (webhook: StoredAppSessionStatusWebhook): object => ({
        appId: webhook.appId,
        configured: true,
        enabled: webhook.enabled,
        endpoint: webhook.endpoint,
        secretId: webhook.secretId,
    });
}

function appUnavailable(): PlatformControlPlaneError {
    return new PlatformControlPlaneError("app_access_denied", "The App is unavailable", 403);
}

function httpsEndpoint(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new PlatformControlPlaneError("invalid_request", "The webhook endpoint is invalid", 400);
    }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
        throw new PlatformControlPlaneError("invalid_request", "The webhook endpoint must be HTTPS", 400);
    }
    return url.toString();
}
