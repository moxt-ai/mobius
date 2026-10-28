import { normalizePairingCode, validateToken } from "../../entity/pairing/pairing.ts";

const RUNTIME_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

async function deriveSecret(secret: string, projectId: string, idempotencyKey: string, purpose: string) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(validateToken(secret)),
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

function encodeToken(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function deriveRuntimeDaemonToken(
    pairingCode: string,
    projectId: string,
    pairingId: string,
    pollTokenHash: string,
): Promise<string> {
    // Keep this derivation stable across deployments. The stored poll verifier
    // is not exposed by claim/redeem, so the printed code alone cannot derive a
    // long-lived credential offline after the server's replay deadline.
    const bytes = await deriveSecret(
        pollTokenHash,
        projectId,
        `${pairingId}\u0000${normalizePairingCode(pairingCode)}`,
        "runtime-daemon-token-v1",
    );
    return `${projectId}_${encodeToken(bytes)}`;
}

export async function deriveRuntimePairingSecrets(ownerToken: string, projectId: string, idempotencyKey: string) {
    const codeBytes = await deriveSecret(ownerToken, projectId, idempotencyKey, "pairing-code");
    let code = "";
    for (const byte of codeBytes.slice(0, 20)) {
        code += RUNTIME_PAIRING_CODE_ALPHABET.charAt(byte % RUNTIME_PAIRING_CODE_ALPHABET.length);
    }
    return {
        pairingCode: code.match(/.{1,4}/g)?.join("-") ?? code,
        pollToken: encodeToken(await deriveSecret(ownerToken, projectId, idempotencyKey, "poll-token")),
    };
}
