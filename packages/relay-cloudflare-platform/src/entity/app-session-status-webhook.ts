export interface StoredAppSessionStatusWebhook {
    readonly appId: string;
    readonly enabled: boolean;
    readonly endpoint: string;
    readonly secretCiphertext: string;
    readonly secretId: string;
    readonly secretNonce: string;
}

export interface AppSessionStatusWebhookSecret {
    readonly ciphertext: string;
    readonly nonce: string;
    readonly plaintext: string;
    readonly secretId: string;
}
