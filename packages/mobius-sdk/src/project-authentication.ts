import { isIdentifier, PROJECT_PERMISSION_NAMES } from "@moxt-ai/mobius-sdk/protocol";
import { MobiusProtocolError, MobiusValidationError } from "./errors.ts";
import type { MobiusCredentialProvider } from "./service-client.ts";

export const MOBIUS_PROJECT_PERMISSIONS: readonly string[] = PROJECT_PERMISSION_NAMES;

function text(value: Readonly<Record<string, unknown>>, key: string, name: string, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function optionalIdentifierField(value: Readonly<Record<string, unknown>>, key: string, name: string): string {
    const field = text(value, key, name, true);
    if (field.length > 0 && !isIdentifier(field)) {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function timestamp(value: Readonly<Record<string, unknown>>, key: string, name: string, allowEmpty = false): string {
    const field = text(value, key, name, allowEmpty);
    if (field.length > 0 && Number.isNaN(Date.parse(field))) {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function _booleanField(value: Readonly<Record<string, unknown>>, key: string, name: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function hasControlCharacters(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (codePoint <= 31 || codePoint === 127) {
            return true;
        }
    }
    return false;
}

function credential(value: string): string {
    if (value.length === 0 || value.length > 16 * 1024 || hasControlCharacters(value)) {
        throw new MobiusValidationError("The credential is invalid");
    }
    return value;
}

export class MobiusCredentialLifecycle {
    static readonly Current = new MobiusCredentialLifecycle("current");
    static readonly Replaced = new MobiusCredentialLifecycle("replaced");
    static readonly Revoked = new MobiusCredentialLifecycle("revoked");

    readonly value: string;

    private constructor(value: string) {
        this.value = value;
    }

    readonly toJSON = (): string => this.value;
}

export abstract class MobiusCredentialReplacement {
    abstract readonly exists: boolean;
}

export class MobiusNoCredentialReplacement extends MobiusCredentialReplacement {
    readonly exists = false;
}

export class MobiusRecordedCredentialReplacement extends MobiusCredentialReplacement {
    readonly credentialId: string;
    readonly exists = true;
    readonly overlapEndsAt: string;

    constructor(credentialId: string, overlapEndsAt: string) {
        super();
        this.credentialId = credentialId;
        this.overlapEndsAt = overlapEndsAt;
    }
}

export abstract class MobiusCredentialState {
    abstract readonly lifecycle: MobiusCredentialLifecycle;
}

export class MobiusCurrentCredentialState extends MobiusCredentialState {
    readonly lifecycle = MobiusCredentialLifecycle.Current;
}

export class MobiusReplacedCredentialState extends MobiusCredentialState {
    readonly lifecycle = MobiusCredentialLifecycle.Replaced;
    readonly replacement: MobiusRecordedCredentialReplacement;

    constructor(replacement: MobiusRecordedCredentialReplacement) {
        super();
        this.replacement = replacement;
    }
}

export class MobiusRevokedCredentialState extends MobiusCredentialState {
    readonly lifecycle = MobiusCredentialLifecycle.Revoked;
    readonly replacement: MobiusCredentialReplacement;
    readonly revokedAt: string;

    constructor(revokedAt: string, replacement: MobiusCredentialReplacement) {
        super();
        this.revokedAt = revokedAt;
        this.replacement = replacement;
    }
}

function _credentialState(value: Readonly<Record<string, unknown>>, name: string): MobiusCredentialState {
    const overlapEndsAt = timestamp(value, "overlapEndsAt", name, true);
    const replacementCredentialId = optionalIdentifierField(value, "replacedByCredentialId", name);
    const revokedAt = timestamp(value, "revokedAt", name, true);
    if ((overlapEndsAt.length === 0) !== (replacementCredentialId.length === 0)) {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    const replacement =
        replacementCredentialId.length === 0
            ? new MobiusNoCredentialReplacement()
            : new MobiusRecordedCredentialReplacement(replacementCredentialId, overlapEndsAt);
    if (revokedAt.length > 0) {
        return new MobiusRevokedCredentialState(revokedAt, replacement);
    }
    if (replacement instanceof MobiusRecordedCredentialReplacement) {
        return new MobiusReplacedCredentialState(replacement);
    }
    return new MobiusCurrentCredentialState();
}

export class RotatingMobiusCredentialProvider implements MobiusCredentialProvider {
    #credential: string;

    constructor(initialCredential: string) {
        this.#credential = credential(initialCredential);
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        return this.#credential;
    };

    readonly replace = (replacement: { readonly credential: string }): void => {
        this.#credential = credential(replacement.credential);
    };
}
