import { decodeIdentifier, type Identifier, isIdentifier, MOBIUS_API_PREFIX } from "@moxt-ai/mobius-sdk/protocol";
import {
    MobiusApiError,
    MobiusCancellationError,
    MobiusConnectionError,
    MobiusError,
    MobiusProtocolError,
    MobiusTimeoutError,
    MobiusValidationError,
} from "./errors.ts";
import type { MobiusCredentialProvider } from "./service-client.ts";
import type { MobiusHttpTransport } from "./transport/http-transport.ts";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;
const MAXIMUM_RESPONSE_LENGTH = 8 * 1024 * 1024;
const PROJECT_PERMISSIONS = Object.freeze([
    "artifact:read",
    "artifact:write",
    "identity-binding:manage",
    "interaction:respond",
    "owner-credential:manage",
    "project:event:read",
    "project:read",
    "runtime:pair",
    "runtime:read",
    "runtime:revoke",
    "session:delete",
    "session:read",
    "session:write",
]);

export const MOBIUS_PROJECT_PERMISSIONS: readonly string[] = PROJECT_PERMISSIONS;

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function records(value: Readonly<Record<string, unknown>>, key: string, name: string): readonly unknown[] {
    const field = value[key];
    if (!Array.isArray(field)) {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    return Object.freeze([...field]);
}

function text(value: Readonly<Record<string, unknown>>, key: string, name: string, allowEmpty = false): string {
    const field = value[key];
    if (typeof field !== "string" || (!allowEmpty && field.length === 0)) {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
    return field;
}

function identifierField(value: Readonly<Record<string, unknown>>, key: string, name: string): Identifier {
    try {
        return decodeIdentifier(value[key]);
    } catch {
        throw new MobiusProtocolError(`The service returned an invalid ${name}`);
    }
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

function permissionList(value: unknown, name: string): readonly string[] {
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((permission) => typeof permission !== "string" || !PROJECT_PERMISSIONS.includes(permission)) ||
        new Set(value).size !== value.length
    ) {
        throw new MobiusProtocolError(`The service returned invalid ${name}`);
    }
    return Object.freeze(value.filter((permission) => typeof permission === "string"));
}

function requestPermissionList(value: readonly string[]): readonly string[] {
    if (
        value.length === 0 ||
        value.some((permission) => !PROJECT_PERMISSIONS.includes(permission)) ||
        new Set(value).size !== value.length
    ) {
        throw new MobiusValidationError("The Project permissions are invalid");
    }
    return Object.freeze([...value]);
}

function identifier(value: string, name: string): Identifier {
    if (!isIdentifier(value)) {
        throw new MobiusValidationError(`The ${name} identifier is invalid`);
    }
    return value;
}

function positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function nonnegativeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
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

function normalizeEndpoint(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch (cause) {
        throw new MobiusValidationError("The Mobius endpoint is invalid", { cause });
    }
    if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0
    ) {
        throw new MobiusValidationError("The Mobius endpoint is invalid");
    }
    if (endpoint.pathname === "/") {
        endpoint.pathname = `${MOBIUS_API_PREFIX}/`;
    } else if (!endpoint.pathname.endsWith("/")) {
        endpoint.pathname = `${endpoint.pathname}/`;
    }
    return endpoint;
}

class PlatformProjectAuthenticationTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
}

class ProjectAuthenticationDeadline {
    readonly #controller = new AbortController();
    readonly #requestSignal: AbortSignal;
    readonly #timeoutId: ReturnType<typeof globalThis.setTimeout>;
    #timedOut = false;

    constructor(requestSignal: AbortSignal, timeoutMilliseconds: number) {
        this.#requestSignal = requestSignal;
        if (requestSignal.aborted) {
            this.#controller.abort(requestSignal.reason);
        } else {
            requestSignal.addEventListener("abort", this.abortFromRequest, { once: true });
        }
        this.#timeoutId = globalThis.setTimeout(this.abortFromTimeout, timeoutMilliseconds);
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    readonly finish = (): void => {
        globalThis.clearTimeout(this.#timeoutId);
        this.#requestSignal.removeEventListener("abort", this.abortFromRequest);
    };

    readonly translate = (cause: unknown): never => {
        if (this.#requestSignal.aborted) {
            throw new MobiusCancellationError({ cause });
        }
        if (this.#timedOut) {
            throw new MobiusTimeoutError({ cause });
        }
        if (cause instanceof MobiusError) {
            throw cause;
        }
        throw new MobiusConnectionError("The Mobius authentication service could not be reached", { cause });
    };

    private readonly abortFromRequest = (): void => {
        this.#controller.abort(this.#requestSignal.reason);
    };

    private readonly abortFromTimeout = (): void => {
        this.#timedOut = true;
        this.#controller.abort(new Error("The Mobius authentication operation timed out"));
    };
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAXIMUM_RESPONSE_LENGTH) {
        throw new MobiusProtocolError("The authentication service response is too large");
    }
    if (response.body === null) {
        return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const result = await reader.read();
            if (result.done) {
                break;
            }
            length += result.value.byteLength;
            if (length > MAXIMUM_RESPONSE_LENGTH) {
                await reader.cancel();
                throw new MobiusProtocolError("The authentication service response is too large");
            }
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch (cause) {
        throw new MobiusProtocolError("The authentication service returned invalid UTF-8", { cause });
    }
}

async function responseValue(response: Response, signal: AbortSignal): Promise<unknown> {
    const encoded = await boundedResponseText(response, signal);
    try {
        return JSON.parse(encoded);
    } catch (cause) {
        throw new MobiusProtocolError("The authentication service returned invalid JSON", { cause });
    }
}

async function throwApiError(response: Response, signal: AbortSignal): Promise<never> {
    const value = record(await responseValue(response, signal), "authentication error response");
    const error = record(value["error"], "authentication error response");
    const code = error["code"];
    const message = error["message"];
    if (typeof code !== "string" || typeof message !== "string") {
        throw new MobiusProtocolError("The authentication service returned an invalid error response");
    }
    throw new MobiusApiError(code, message, response.status);
}

class ProjectAuthenticationRequestExecutor {
    readonly #actorReference: string;
    readonly #credentialProvider: MobiusCredentialProvider;
    readonly #endpoint: URL;
    readonly #operationTimeoutMilliseconds: number;
    readonly #transport: MobiusHttpTransport;

    constructor(options: MobiusProjectAuthenticationClientOptions) {
        this.#endpoint = normalizeEndpoint(options.endpoint);
        this.#credentialProvider = options.credentialProvider;
        this.#operationTimeoutMilliseconds = positiveInteger(
            options.operationTimeoutMilliseconds ?? DEFAULT_OPERATION_TIMEOUT_MILLISECONDS,
            "operation timeout",
        );
        this.#transport = options.transport ?? new PlatformProjectAuthenticationTransport();
        const actorReference = options.actorReference ?? "";
        if (actorReference.length > 200 || hasControlCharacters(actorReference)) {
            throw new MobiusValidationError("The Mobius actor reference is invalid");
        }
        this.#actorReference = actorReference;
    }

    readonly projectGet = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "GET", "", this.#credentialProvider, this.#actorReference, signal);

    readonly projectPost = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "POST", this.encode(body), this.#credentialProvider, this.#actorReference, signal);

    readonly projectDelete = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "DELETE", "", this.#credentialProvider, this.#actorReference, signal);

    readonly externalPost = async (
        path: string,
        body: unknown,
        externalCredentialProvider: MobiusCredentialProvider,
        signal: AbortSignal,
    ): Promise<unknown> => await this.request(path, "POST", this.encode(body), externalCredentialProvider, "", signal);

    private readonly encode = (body: unknown): string => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MobiusValidationError("The authentication request body is invalid");
        }
        return encoded;
    };

    private readonly request = async (
        path: string,
        method: string,
        body: string,
        credentialProvider: MobiusCredentialProvider,
        actorReference: string,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new ProjectAuthenticationDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const headers = new Headers({ accept: "application/json" });
            headers.set("authorization", `Bearer ${credential(await credentialProvider.credential(deadline.signal))}`);
            if (actorReference.length > 0) {
                headers.set("x-mobius-actor-ref", actorReference);
            }
            if (body.length > 0) {
                headers.set("content-type", "application/json");
            }
            let request: Request;
            if (body.length > 0) {
                request = new Request(new URL(path, this.#endpoint), {
                    body,
                    headers,
                    method,
                    signal: deadline.signal,
                });
            } else {
                request = new Request(new URL(path, this.#endpoint), {
                    headers,
                    method,
                    signal: deadline.signal,
                });
            }
            const response = await this.#transport.fetch(request);
            if (!response.ok) {
                return await throwApiError(response, deadline.signal);
            }
            return await responseValue(response, deadline.signal);
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };
}

export interface MobiusProjectAuthenticationClientOptions {
    readonly actorReference?: string;
    readonly credentialProvider: MobiusCredentialProvider;
    readonly endpoint: string;
    readonly operationTimeoutMilliseconds?: number;
    readonly projectId: string;
    readonly transport?: MobiusHttpTransport;
}

export interface AttachMobiusExternalIdentityRequest {
    readonly externalCredential: string;
    readonly permissions: readonly string[];
    readonly providerId: string;
}

export interface ExchangeMobiusExternalIdentityRequest {
    readonly expiresInSeconds: number;
    readonly providerId: string;
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

export class MobiusExternalIdentityBinding {
    readonly bindingId: string;
    readonly createdAt: string;
    readonly grantId: string;
    readonly issuer: string;
    readonly lastVerifiedAt: string;
    readonly permissions: readonly string[];
    readonly projectId: string;
    readonly providerId: string;
    readonly subject: string;

    constructor(value: unknown) {
        const resource = record(value, "external identity binding");
        this.bindingId = identifierField(resource, "bindingId", "external identity binding");
        this.grantId = identifierField(resource, "grantId", "external identity binding");
        this.projectId = identifierField(resource, "projectId", "external identity binding");
        this.providerId = identifierField(resource, "providerId", "external identity binding");
        this.issuer = text(resource, "issuer", "external identity binding");
        this.subject = text(resource, "subject", "external identity binding");
        this.permissions = permissionList(resource["permissions"], "external identity binding permissions");
        this.createdAt = timestamp(resource, "createdAt", "external identity binding");
        this.lastVerifiedAt = timestamp(resource, "lastVerifiedAt", "external identity binding");
    }
}

export class MobiusAttachedExternalIdentity extends MobiusExternalIdentityBinding {
    constructor(value: unknown) {
        super(value);
    }
}

export class MobiusIssuedProjectAccessCredential {
    readonly credential: string;
    readonly credentialId: string;
    readonly expiresAt: string;
    readonly permissions: readonly string[];
    readonly projectId: string;

    constructor(value: unknown) {
        const resource = record(value, "issued Mobius access credential");
        this.credential = credential(text(resource, "credential", "issued Mobius access credential"));
        this.credentialId = identifierField(resource, "credentialId", "issued Mobius access credential");
        this.projectId = identifierField(resource, "projectId", "issued Mobius access credential");
        this.expiresAt = timestamp(resource, "expiresAt", "issued Mobius access credential");
        this.permissions = permissionList(resource["permissions"], "Mobius access credential permissions");
    }
}

export class MobiusAuthenticationAuditEvent {
    readonly action: string;
    readonly actorId: string;
    readonly actorKind: string;
    readonly actorRef: string;
    readonly auditId: string;
    readonly details: Readonly<Record<string, unknown>>;
    readonly outcome: string;
    readonly recordedAt: string;
    readonly subjectId: string;

    constructor(value: unknown) {
        const resource = record(value, "authentication audit event");
        this.auditId = identifierField(resource, "auditId", "authentication audit event");
        this.actorKind = text(resource, "actorKind", "authentication audit event");
        this.actorId = text(resource, "actorId", "authentication audit event");
        this.actorRef = text(resource, "actorRef", "authentication audit event", true);
        this.action = text(resource, "action", "authentication audit event");
        this.subjectId = text(resource, "subjectId", "authentication audit event");
        this.outcome = text(resource, "outcome", "authentication audit event");
        this.details = record(resource["details"], "authentication audit details");
        this.recordedAt = timestamp(resource, "recordedAt", "authentication audit event");
    }
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

abstract class ExchangedCredentialState {
    abstract readonly isUsable: (now: number, refreshAheadMilliseconds: number) => boolean;
    abstract readonly read: () => string;
}

class EmptyExchangedCredentialState extends ExchangedCredentialState {
    readonly isUsable = (_now: number, _refreshAheadMilliseconds: number): boolean => false;
    readonly read = (): string => {
        throw new MobiusProtocolError("A Mobius access credential has not been exchanged");
    };
}

class ReadyExchangedCredentialState extends ExchangedCredentialState {
    readonly #credential: string;
    readonly #expiresAt: number;

    constructor(value: MobiusIssuedProjectAccessCredential) {
        super();
        this.#credential = value.credential;
        this.#expiresAt = Date.parse(value.expiresAt);
    }

    readonly isUsable = (now: number, refreshAheadMilliseconds: number): boolean =>
        this.#expiresAt - now > refreshAheadMilliseconds;
    readonly read = (): string => this.#credential;
}

export class ExchangingMobiusCredentialProvider implements MobiusCredentialProvider {
    readonly #client: MobiusProjectAuthenticationClient;
    readonly #externalCredentialProvider: MobiusCredentialProvider;
    readonly #lifetimeSeconds: number;
    readonly #providerId: string;
    readonly #refreshAheadMilliseconds: number;
    #state: ExchangedCredentialState = new EmptyExchangedCredentialState();

    constructor(
        client: MobiusProjectAuthenticationClient,
        providerId: string,
        externalCredentialProvider: MobiusCredentialProvider,
        lifetimeSeconds: number,
        refreshAheadMilliseconds = 30_000,
    ) {
        this.#client = client;
        this.#providerId = identifier(providerId, "external provider");
        this.#externalCredentialProvider = externalCredentialProvider;
        this.#lifetimeSeconds = positiveInteger(lifetimeSeconds, "access credential lifetime");
        this.#refreshAheadMilliseconds = nonnegativeInteger(refreshAheadMilliseconds, "credential refresh window");
    }

    readonly credential = async (signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        if (this.#state.isUsable(Date.now(), this.#refreshAheadMilliseconds)) {
            return this.#state.read();
        }
        const exchanged = await this.#client.exchangeExternalIdentity(
            { expiresInSeconds: this.#lifetimeSeconds, providerId: this.#providerId },
            this.#externalCredentialProvider,
            signal,
        );
        this.#state = new ReadyExchangedCredentialState(exchanged);
        return this.#state.read();
    };
}

export class MobiusExternalIdentityBindingResource {
    readonly #client: MobiusProjectAuthenticationClient;

    constructor(client: MobiusProjectAuthenticationClient) {
        this.#client = client;
    }

    readonly attach = async (
        request: AttachMobiusExternalIdentityRequest,
        signal: AbortSignal,
    ): Promise<MobiusAttachedExternalIdentity> =>
        new MobiusAttachedExternalIdentity(
            await this.#client.projectPost(
                `v1/projects/${encodeURIComponent(this.#client.projectId)}/external-identity-bindings`,
                {
                    externalCredential: credential(request.externalCredential),
                    permissions: requestPermissionList(request.permissions),
                    providerId: identifier(request.providerId, "external provider"),
                },
                signal,
            ),
        );

    readonly list = async (signal: AbortSignal): Promise<readonly MobiusExternalIdentityBinding[]> => {
        const value = record(
            await this.#client.projectGet(
                `v1/projects/${encodeURIComponent(this.#client.projectId)}/external-identity-bindings`,
                signal,
            ),
            "external identity binding directory",
        );
        return Object.freeze(
            records(value, "bindings", "external identity binding directory").map(
                (binding) => new MobiusExternalIdentityBinding(binding),
            ),
        );
    };

    readonly revoke = async (bindingId: string, signal: AbortSignal): Promise<void> => {
        await this.#client.projectDelete(
            `v1/projects/${encodeURIComponent(this.#client.projectId)}/external-identity-bindings/${encodeURIComponent(identifier(bindingId, "external identity binding"))}`,
            signal,
        );
    };
}

export class MobiusAuthenticationAuditResource {
    readonly #client: MobiusProjectAuthenticationClient;

    constructor(client: MobiusProjectAuthenticationClient) {
        this.#client = client;
    }

    readonly list = async (limit: number, signal: AbortSignal): Promise<readonly MobiusAuthenticationAuditEvent[]> => {
        const value = record(
            await this.#client.projectGet(
                `v1/projects/${encodeURIComponent(this.#client.projectId)}/authentication-audit-events?limit=${positiveInteger(limit, "audit page size").toString()}`,
                signal,
            ),
            "authentication audit event directory",
        );
        return Object.freeze(
            records(value, "events", "authentication audit event directory").map(
                (event) => new MobiusAuthenticationAuditEvent(event),
            ),
        );
    };
}

export class MobiusProjectAuthenticationClient {
    readonly auditEvents: MobiusAuthenticationAuditResource;
    readonly externalIdentityBindings: MobiusExternalIdentityBindingResource;
    readonly projectId: string;
    readonly #requests: ProjectAuthenticationRequestExecutor;

    constructor(options: MobiusProjectAuthenticationClientOptions) {
        this.projectId = identifier(options.projectId, "Project");
        this.#requests = new ProjectAuthenticationRequestExecutor(options);
        this.externalIdentityBindings = new MobiusExternalIdentityBindingResource(this);
        this.auditEvents = new MobiusAuthenticationAuditResource(this);
    }

    readonly exchangeExternalIdentity = async (
        request: ExchangeMobiusExternalIdentityRequest,
        externalCredentialProvider: MobiusCredentialProvider,
        signal: AbortSignal,
    ): Promise<MobiusIssuedProjectAccessCredential> =>
        new MobiusIssuedProjectAccessCredential(
            await this.#requests.externalPost(
                `v1/auth/exchanges/${encodeURIComponent(identifier(request.providerId, "external provider"))}`,
                {
                    expiresInSeconds: positiveInteger(request.expiresInSeconds, "access credential lifetime"),
                    projectId: this.projectId,
                },
                externalCredentialProvider,
                signal,
            ),
        );

    readonly projectDelete = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.#requests.projectDelete(path, signal);
    readonly projectGet = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.#requests.projectGet(path, signal);
    readonly projectPost = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> =>
        await this.#requests.projectPost(path, body, signal);
}
