const KEY_BYTES = 32;

export function parseWebhookEncryptionKey(value: string): ArrayBuffer {
    const decoded = unbase64(value);
    if (decoded.byteLength !== KEY_BYTES) {
        throw new Error("The App Session status webhook encryption key must contain 32 bytes");
    }
    return decoded.buffer;
}

export async function encryptWebhookSecret(
    plaintext: string,
    key: ArrayBuffer,
): Promise<{ readonly ciphertext: string; readonly nonce: string }> {
    const nonce = randomBytes(12);
    const encrypted = await crypto.subtle.encrypt(
        { iv: nonce, name: "AES-GCM" },
        await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]),
        new TextEncoder().encode(plaintext),
    );
    return { ciphertext: base64(new Uint8Array(encrypted)), nonce: base64(nonce) };
}

export async function decryptWebhookSecret(ciphertext: string, nonce: string, key: ArrayBuffer): Promise<string> {
    try {
        const plain = await crypto.subtle.decrypt(
            { iv: unbase64(nonce), name: "AES-GCM" },
            await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]),
            unbase64(ciphertext),
        );
        return new TextDecoder().decode(plain);
    } catch (cause) {
        throw new Error("The App Session status webhook secret could not be decrypted", { cause });
    }
}

function base64(value: Uint8Array): string {
    return btoa(String.fromCharCode(...value));
}

function unbase64(value: string): Uint8Array<ArrayBuffer> {
    const source = Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
    const decoded = new Uint8Array(new ArrayBuffer(source.byteLength));
    decoded.set(source);
    return decoded;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(new ArrayBuffer(length));
    return crypto.getRandomValues(bytes);
}
