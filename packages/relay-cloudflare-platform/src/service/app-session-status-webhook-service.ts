import { createRandomToken, type VerifiedExternalIdentity } from "@moxt-ai/mobius-relay-core";
import type { StoredAppSessionStatusWebhook } from "../entity/app-session-status-webhook.ts";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";
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
        const current = await this.#authorized(identity, appId, signal);
        return current === null ? { appId, configured: false } : this.resource(current);
    };

    readonly write = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        enabled: boolean,
        endpoint: string,
        signal: AbortSignal,
    ): Promise<object> => {
        const current = await this.#authorized(identity, appId, signal);
        const normalizedEndpoint = httpsEndpoint(endpoint);
        const secret = current === null ? await this.#newSecret() : undefined;
        const previous = current;
        const stored = await this.#storage.write(
            {
                appId,
                enabled,
                endpoint: normalizedEndpoint,
                secretCiphertext: secret?.ciphertext ?? previous?.secretCiphertext ?? "",
                secretId: secret?.secretId ?? previous?.secretId ?? "",
                secretNonce: secret?.nonce ?? previous?.secretNonce ?? "",
            },
            Date.now(),
        );
        signal.throwIfAborted();
        return { ...this.resource(stored), ...(secret === undefined ? {} : { secret: secret.plaintext }) };
    };

    readonly rotate = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        signal: AbortSignal,
    ): Promise<object> => {
        const current = await this.#authorized(identity, appId, signal);
        if (current === null) {
            throw new PlatformControlPlaneError("webhook_not_found", "The App webhook is not configured", 404);
        }
        const secret = await this.#newSecret();
        const stored = await this.#storage.write(
            { ...current, secretCiphertext: secret.ciphertext, secretId: secret.secretId, secretNonce: secret.nonce },
            Date.now(),
        );
        signal.throwIfAborted();
        return { ...this.resource(stored), secret: secret.plaintext };
    };

    readonly decryptSecret = async (webhook: StoredAppSessionStatusWebhook): Promise<string> =>
        await decryptWebhookSecret(webhook.secretCiphertext, webhook.secretNonce, this.#encryptionKey);

    readonly #authorized = async (
        identity: VerifiedExternalIdentity,
        appId: string,
        signal: AbortSignal,
    ): Promise<StoredAppSessionStatusWebhook | null> => {
        if (this.#control === null) {
            throw new Error("The App Session status webhook service is not configured for dashboard access");
        }
        await this.#control.requireAppDeveloper(identity, appId, signal);
        return await this.#storage.read(appId);
    };

    readonly #newSecret = async () => {
        const secretId = createRandomToken(12);
        const plaintext = `mweb_${secretId}_${createRandomToken(32)}`;
        return { plaintext, secretId, ...(await encryptWebhookSecret(plaintext, this.#encryptionKey)) };
    };

    readonly resource = (webhook: StoredAppSessionStatusWebhook): object => ({
        appId: webhook.appId,
        enabled: webhook.enabled,
        endpoint: webhook.endpoint,
        secretId: webhook.secretId,
    });
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
