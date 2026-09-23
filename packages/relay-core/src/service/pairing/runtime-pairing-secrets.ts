import { validateToken } from "../../entity/pairing/pairing.ts";

const RUNTIME_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function deriveSecret(ownerToken: string, projectId: string, idempotencyKey: string, purpose: string) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(validateToken(ownerToken)),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign"],
    );
    return new Uint8Array(
        await crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(`${purpose}\u0000${projectId}\u0000${idempotencyKey}`),
        ),
    );
}

export async function deriveRuntimePairingSecrets(ownerToken: string, projectId: string, idempotencyKey: string) {
    const codeBytes = await deriveSecret(ownerToken, projectId, idempotencyKey, "pairing-code");
    let code = "";
    for (const byte of codeBytes.slice(0, 20)) {
        code += RUNTIME_PAIRING_CODE_ALPHABET.charAt(byte % RUNTIME_PAIRING_CODE_ALPHABET.length);
    }
    let binary = "";
    for (const byte of await deriveSecret(ownerToken, projectId, idempotencyKey, "poll-token")) {
        binary += String.fromCharCode(byte);
    }
    return {
        pairingCode: code.match(/.{1,4}/g)?.join("-") ?? code,
        pollToken: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
    };
}
