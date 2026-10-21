import { z } from "zod";
import { identifierStringSchema } from "../../shared/identifier.ts";
import { ProtocolMessageError } from "../../shared/message-codec.ts";

const APP_CREDENTIAL_PATTERN = /^mapp_([A-Za-z0-9_-]{22})_[A-Za-z0-9_-]{43}$/u;
const SESSION_ACCESS_PATTERN = /^msession_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]{43})$/u;
const MAXIMUM_LIFETIME_MILLISECONDS = 15 * 60 * 1_000;

const claimsSchema = z
    .object({
        expiresAtEpochMilliseconds: z.number().int().nonnegative(),
        issuedAtEpochMilliseconds: z.number().int().nonnegative(),
        projectId: identifierStringSchema,
        purpose: z.literal("session-access"),
        runtimeId: identifierStringSchema,
        sessionId: identifierStringSchema,
    })
    .readonly();

export type SessionAccessClaims = z.infer<typeof claimsSchema>;

export interface SessionAccessCredential {
    readonly claims: SessionAccessClaims;
    readonly publicCredentialId: string;
    readonly signature: ArrayBuffer;
    readonly signedValue: string;
}

function encodeBase64Url(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
    try {
        const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
        const binary = atob(padded);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch (cause) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause });
    }
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(value);
    return buffer;
}

async function signingKey(secretDigest: string): Promise<CryptoKey> {
    if (!/^[a-f0-9]{64}$/u.test(secretDigest)) {
        throw new ProtocolMessageError("The Session credential signing key is invalid");
    }
    return await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secretDigest),
        { hash: "SHA-256", name: "HMAC" },
        false,
        ["sign", "verify"],
    );
}

async function digestCredential(credential: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(credential));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function issueSessionAccessCredential(
    appCredential: string,
    claims: SessionAccessClaims,
): Promise<string> {
    const match = APP_CREDENTIAL_PATTERN.exec(appCredential);
    if (match === null) {
        throw new ProtocolMessageError("The App credential is invalid");
    }
    const validatedClaims = claimsSchema.parse(claims);
    if (
        validatedClaims.expiresAtEpochMilliseconds <= validatedClaims.issuedAtEpochMilliseconds ||
        validatedClaims.expiresAtEpochMilliseconds - validatedClaims.issuedAtEpochMilliseconds >
            MAXIMUM_LIFETIME_MILLISECONDS
    ) {
        throw new ProtocolMessageError("The Session credential lifetime is invalid");
    }
    const publicCredentialId = match[1];
    if (publicCredentialId === undefined) {
        throw new ProtocolMessageError("The App credential is invalid");
    }
    const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(validatedClaims)));
    const signedValue = `msession_${publicCredentialId}_${payload}`;
    const signature = await crypto.subtle.sign(
        "HMAC",
        await signingKey(await digestCredential(appCredential)),
        new TextEncoder().encode(signedValue),
    );
    return `${signedValue}_${encodeBase64Url(new Uint8Array(signature))}`;
}

export function decodeSessionAccessCredential(credential: string): SessionAccessCredential {
    const match = SESSION_ACCESS_PATTERN.exec(credential);
    const publicCredentialId = match?.[1];
    const payload = match?.[2];
    const encodedSignature = match?.[3];
    if (publicCredentialId === undefined || payload === undefined || encodedSignature === undefined) {
        throw new ProtocolMessageError("The Session credential is invalid");
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
    } catch (cause) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause });
    }
    const parsed = claimsSchema.safeParse(decoded);
    if (!parsed.success) {
        throw new ProtocolMessageError("The Session credential is invalid", { cause: parsed.error });
    }
    return {
        claims: parsed.data,
        publicCredentialId,
        signature: exactBuffer(decodeBase64Url(encodedSignature)),
        signedValue: `msession_${publicCredentialId}_${payload}`,
    };
}

export async function verifySessionAccessCredential(
    credential: string,
    secretDigest: string,
    nowEpochMilliseconds: number,
): Promise<SessionAccessClaims> {
    const decoded = decodeSessionAccessCredential(credential);
    const valid = await crypto.subtle.verify(
        "HMAC",
        await signingKey(secretDigest),
        decoded.signature,
        new TextEncoder().encode(decoded.signedValue),
    );
    if (
        !valid ||
        !Number.isSafeInteger(nowEpochMilliseconds) ||
        decoded.claims.issuedAtEpochMilliseconds > nowEpochMilliseconds ||
        decoded.claims.expiresAtEpochMilliseconds <= nowEpochMilliseconds ||
        decoded.claims.expiresAtEpochMilliseconds - decoded.claims.issuedAtEpochMilliseconds >
            MAXIMUM_LIFETIME_MILLISECONDS
    ) {
        throw new ProtocolMessageError("The Session credential is invalid or expired");
    }
    return decoded.claims;
}
