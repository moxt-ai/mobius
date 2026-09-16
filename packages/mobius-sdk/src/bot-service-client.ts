import {
    decodePromptImagesValue,
    decodePromptResourcesValue,
    decodeSessionConfigOptions,
    MOBIUS_API_PREFIX,
    type PromptImage,
    type PromptResource,
    type SessionConfigOption,
} from "@moxt-ai/mobius-protocol";
import {
    decodeMobiusBot,
    decodeMobiusBotBehavior,
    decodeMobiusOwnerBotConversation,
    type MobiusBot,
    MobiusBotBehaviorDirectory,
    type MobiusBotBehaviorRevision,
    MobiusBotBindingDirectory,
    MobiusBotBindingRequestAcceptance,
    MobiusBotCompletionPolicy,
    MobiusBotConnectionDirectory,
    MobiusBotConnectionGrant,
    type MobiusBotConversation,
    MobiusBotConversationDirectory,
    MobiusBotDirectory,
    MobiusBotProfileRevision,
    MobiusNoBotCompletionPolicy,
    MobiusProjectConversation,
    MobiusRequiredBotCompletionPolicy,
} from "./bot-owner-resources.ts";
import {
    MobiusBotConnectionCredential,
    MobiusBotConnectionCredentialRotation,
    MobiusBotConversationEventPage,
    MobiusBotConversationMessagePage,
    MobiusBotDeliveryAcknowledgement,
    MobiusBotDeliveryTarget,
    MobiusBotOutboundEventPage,
    MobiusBotTurnAcceptance,
    MobiusBotTurnCancellationAcceptance,
    MobiusConnectedBotConversation,
    MobiusDisabledBotDeliveryTarget,
    MobiusRevokedBotConnection,
} from "./bot-resources.ts";
import {
    MobiusApiError,
    MobiusCancellationError,
    MobiusConnectionError,
    MobiusError,
    MobiusProtocolError,
    MobiusTimeoutError,
    MobiusValidationError,
} from "./errors.ts";
import { decodeMobiusTurn, type MobiusPageRequest, type MobiusTurn } from "./resources.ts";
import type { MobiusCredentialProvider, MobiusHttpTransport } from "./service-client.ts";

export const MOBIUS_BOT_API_VERSION = "v1";

const DEFAULT_OPERATION_TIMEOUT_MILLISECONDS = 20_000;
const MAX_RESPONSE_LENGTH = 8 * 1024 * 1024;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

export interface MobiusBotResponseMetadata {
    readonly serverTiming: string | null;
    readonly status: number;
}

export interface MobiusBotApiOptions {
    readonly endpoint: string;
    readonly observeResponse?: (metadata: MobiusBotResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

export interface MobiusBotConnectorClientOptions extends MobiusBotApiOptions {
    readonly connectionId: string;
    readonly credentialProvider: MobiusCredentialProvider;
    readonly projectId: string;
}

export interface MobiusBotOwnerClientOptions extends MobiusBotApiOptions {
    readonly actorReference?: string;
    readonly credentialProvider: MobiusCredentialProvider;
    readonly projectId: string;
}

export interface CreateMobiusBotRequest {
    readonly avatarRef: string;
    readonly description: string;
    readonly displayName: string;
}

export interface ReviseMobiusBotProfileRequest extends CreateMobiusBotRequest {
    readonly expectedRevision: number;
}

export interface CreateMobiusBotBehaviorRequest {
    readonly agentConfiguration: Readonly<Record<string, unknown>>;
    readonly expectedRevision: number;
    readonly instructions: string;
    readonly requiredCapabilities: readonly string[];
}

export interface CreateMobiusBotBindingRequest {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly allowedDeliveryTargetIds: readonly string[];
    readonly behaviorRevisionId: string;
    readonly completionPolicy: MobiusBotCompletionPolicy;
    readonly expectedRevision: number;
    readonly runtimeId: string;
    readonly workspaceRef: string;
}

export interface CreateMobiusBotConnectionGrantRequest {
    readonly audience: string;
    readonly expiresInSeconds: number;
    readonly label: string;
    readonly scopes: readonly string[];
}

export interface CreateMobiusOwnerConversationRequest {
    readonly clientConversationKey: string;
}

export interface MobiusConversationConfigurationRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly idempotencyKey: string;
    readonly value: string;
    readonly valueType: string;
}

export interface MobiusInitialConversationConfigurationRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly value: string;
    readonly valueType: string;
}

export interface CreateMobiusProjectConversationRequest {
    readonly botId: string;
    readonly clientReference: string;
    readonly configuration: MobiusInitialConversationConfigurationRequest;
    readonly idempotencyKey: string;
    readonly title: string;
}

export interface SubmitMobiusProjectConversationTurnRequest {
    readonly additionalDirectoryIds: readonly string[];
    readonly artifactIds: readonly string[];
    readonly content: string;
    readonly idempotencyKey: string;
    readonly images: readonly PromptImage[];
    readonly resources: readonly PromptResource[];
}

export class MobiusProjectConversationTurnAcceptance {
    readonly duplicate: boolean;
    readonly eventCursor: string;
    readonly executionId: string;
    readonly turn: MobiusTurn;
    readonly turnId: string;

    constructor(value: unknown) {
        const resource = responseRecord(value);
        if (typeof resource["duplicate"] !== "boolean") {
            throw new MobiusProtocolError("The Project Conversation turn acceptance is invalid");
        }
        this.duplicate = resource["duplicate"];
        this.eventCursor = boundedText(resource["eventCursor"], "Conversation event cursor", 512, true);
        this.executionId = identifier(resource["executionId"], "Conversation execution");
        this.turn = decodeMobiusTurn(resource["turn"]);
        this.turnId = identifier(resource["turnId"], "Conversation turn");
        if (this.turn.turnId !== this.turnId) {
            throw new MobiusProtocolError("The Project Conversation turn acceptance is inconsistent");
        }
    }
}

export class MobiusConversationConfigurationAcceptance {
    readonly duplicate: boolean;
    readonly requestId: string;
    readonly status = "accepted";

    constructor(value: unknown) {
        const resource = responseRecord(value);
        if (typeof resource["duplicate"] !== "boolean" || resource["status"] !== "accepted") {
            throw new MobiusProtocolError("The Conversation configuration acceptance is invalid");
        }
        this.duplicate = resource["duplicate"];
        this.requestId = identifier(resource["requestId"], "Conversation configuration request");
    }
}

export class MobiusBotAgentConfiguration {
    readonly options: readonly SessionConfigOption[];

    constructor(value: unknown) {
        const resource = responseRecord(value);
        if (Object.keys(resource).length !== 1 || !Object.hasOwn(resource, "options")) {
            throw new MobiusProtocolError("The Bot Agent configuration response is invalid");
        }
        try {
            this.options = decodeSessionConfigOptions(resource["options"]);
        } catch (cause) {
            throw new MobiusProtocolError("The Bot Agent configuration response is invalid", { cause });
        }
    }
}

export interface RedeemMobiusBotConnectionGrantRequest {
    readonly audience: string;
    readonly connectorPrincipalId: string;
    readonly grantId: string;
    readonly grantSecret: string;
}

export interface CreateMobiusBotDeliveryTargetRequest {
    readonly alias: string;
}

export interface CreateMobiusConnectedConversationRequest {
    readonly clientConversationKey: string;
    readonly replyDeliveryTargetId: string;
    readonly title: string;
}

export interface SubmitMobiusBotMessageRequest {
    readonly actorRef: string;
    readonly clientMessageId: string;
    readonly resourceRefs: readonly string[];
    readonly text: string;
}

export interface SubmitMobiusOwnerBotMessageRequest {
    readonly actorRef: string;
    readonly artifactIds: readonly string[];
    readonly clientMessageId: string;
    readonly text: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestRecord(value: unknown, fields: readonly string[], name: string): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw new MobiusValidationError(`The ${name} fields are invalid`);
    }
    return value;
}

function identifier(value: unknown, name: string): string {
    if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
        throw new MobiusValidationError(`The ${name} identifier is invalid`);
    }
    return value;
}

function boundedText(value: unknown, name: string, maximum: number, allowEmpty = false): string {
    if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.trim().length === 0)) {
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

function auditActorReference(value: unknown): string {
    if (value === undefined) {
        return "";
    }
    if (typeof value !== "string" || value.length > 200 || hasControlCharacters(value)) {
        throw new MobiusValidationError("The Mobius actor reference is invalid");
    }
    return value;
}

function token(value: unknown, name: string): string {
    if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function identifiers(value: unknown, name: string, maximum: number): readonly string[] {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    const normalized: string[] = [];
    const unique = new Set<string>();
    for (const candidate of value) {
        const validated = identifier(candidate, name);
        if (unique.has(validated)) {
            throw new MobiusValidationError(`The ${name} contains a duplicate`);
        }
        unique.add(validated);
        normalized.push(validated);
    }
    return Object.freeze(normalized);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new MobiusValidationError(`The ${name} is invalid`);
    }
    return value;
}

function normalizeEndpoint(value: string): URL {
    let endpoint: URL;
    try {
        endpoint = new URL(value);
    } catch (cause) {
        throw new MobiusValidationError("The Mobius Bot API endpoint is invalid", { cause });
    }
    if (
        (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0
    ) {
        throw new MobiusValidationError("The Mobius Bot API endpoint is invalid");
    }
    if (endpoint.pathname === "/") {
        endpoint.pathname = `${MOBIUS_API_PREFIX}/`;
    } else if (!endpoint.pathname.endsWith("/")) {
        endpoint.pathname = `${endpoint.pathname}/`;
    }
    return endpoint;
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(value)) {
        throw new MobiusProtocolError("The Bot API returned an invalid error response");
    }
    return value;
}

abstract class BotRequestAuthentication {
    abstract readonly apply: (headers: Headers, signal: AbortSignal) => Promise<void>;
}

class AnonymousBotRequestAuthentication extends BotRequestAuthentication {
    readonly apply = async (_headers: Headers, signal: AbortSignal): Promise<void> => {
        signal.throwIfAborted();
    };
}

class CredentialBotRequestAuthentication extends BotRequestAuthentication {
    readonly #provider: MobiusCredentialProvider;

    constructor(provider: MobiusCredentialProvider) {
        super();
        this.#provider = provider;
    }

    readonly apply = async (headers: Headers, signal: AbortSignal): Promise<void> => {
        headers.set("authorization", `Bearer ${token(await this.#provider.credential(signal), "Mobius credential")}`);
    };
}

class PlatformMobiusBotTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
}

class BotRequestDeadline {
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
        throw new MobiusConnectionError("The Mobius Bot API could not be reached", { cause });
    };

    private readonly abortFromRequest = (): void => this.#controller.abort(this.#requestSignal.reason);

    private readonly abortFromTimeout = (): void => {
        this.#timedOut = true;
        this.#controller.abort(new Error("The Mobius Bot API operation timed out"));
    };
}

class BotRequestExecutor {
    readonly #actorReference: string;
    readonly #authentication: BotRequestAuthentication;
    readonly #endpoint: URL;
    readonly #operationTimeoutMilliseconds: number;
    readonly #observeResponse: ((metadata: MobiusBotResponseMetadata) => void) | undefined;
    readonly #transport: MobiusHttpTransport;

    constructor(options: MobiusBotApiOptions, authentication: BotRequestAuthentication, actorReference: string) {
        this.#actorReference = actorReference;
        this.#authentication = authentication;
        this.#endpoint = normalizeEndpoint(options.endpoint);
        this.#operationTimeoutMilliseconds = boundedInteger(
            options.operationTimeoutMilliseconds ?? DEFAULT_OPERATION_TIMEOUT_MILLISECONDS,
            "operation timeout",
            1,
            300_000,
        );
        this.#observeResponse = options.observeResponse;
        this.#transport = options.transport ?? new PlatformMobiusBotTransport();
    }

    readonly get = async (path: string, signal: AbortSignal): Promise<unknown> =>
        await this.request(path, "GET", "", false, signal);

    readonly post = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
        const encoded = JSON.stringify(body);
        if (typeof encoded !== "string") {
            throw new MobiusValidationError("The Mobius Bot API request is invalid");
        }
        return await this.request(path, "POST", encoded, true, signal);
    };

    private readonly request = async (
        path: string,
        method: string,
        encodedBody: string,
        includesBody: boolean,
        signal: AbortSignal,
    ): Promise<unknown> => {
        const deadline = new BotRequestDeadline(signal, this.#operationTimeoutMilliseconds);
        try {
            const headers = new Headers({ accept: "application/json" });
            if (includesBody) {
                headers.set("content-type", "application/json");
            }
            if (this.#actorReference.length > 0) {
                headers.set("x-mobius-actor-ref", this.#actorReference);
            }
            await this.#authentication.apply(headers, deadline.signal);
            const url = new URL(path, this.#endpoint);
            const request = includesBody
                ? new Request(url, { body: encodedBody, headers, method, signal: deadline.signal })
                : new Request(url, { headers, method, signal: deadline.signal });
            const response = await this.#transport.fetch(request);
            deadline.signal.throwIfAborted();
            this.#observeResponse?.({
                serverTiming: response.headers.get("server-timing"),
                status: response.status,
            });
            const encoded = await response.text();
            if (encoded.length === 0 || encoded.length > MAX_RESPONSE_LENGTH) {
                throw new MobiusProtocolError("The Mobius Bot API returned an invalid response");
            }
            let value: unknown;
            try {
                value = JSON.parse(encoded);
            } catch (cause) {
                throw new MobiusProtocolError("The Mobius Bot API returned invalid JSON", { cause });
            }
            if (!response.ok) {
                const error = responseRecord(responseRecord(value)["error"]);
                const code = error["code"];
                const message = error["message"];
                if (typeof code !== "string" || typeof message !== "string") {
                    throw new MobiusProtocolError("The Mobius Bot API returned an invalid error response");
                }
                throw new MobiusApiError(code, message, response.status);
            }
            return value;
        } catch (cause) {
            return deadline.translate(cause);
        } finally {
            deadline.finish();
        }
    };
}

function projectBotPath(projectId: string, botId: string, resource: string): string {
    const base = `${projectBotsPath(projectId)}/${encodeURIComponent(identifier(botId, "Bot"))}`;
    return resource.length === 0 ? base : `${base}/${resource}`;
}

function projectBotsPath(projectId: string): string {
    return `${MOBIUS_BOT_API_VERSION}/projects/${encodeURIComponent(identifier(projectId, "project"))}/bots`;
}

function projectConversationsPath(projectId: string): string {
    return `${MOBIUS_BOT_API_VERSION}/projects/${encodeURIComponent(identifier(projectId, "project"))}/conversations`;
}

function conversationPath(projectId: string, conversationId: string, resource: string): string {
    const base = `${projectConversationsPath(projectId)}/${encodeURIComponent(identifier(conversationId, "conversation"))}`;
    return resource.length === 0 ? base : `${base}/${resource}`;
}

function serializedConversationConfiguration(request: unknown): Readonly<Record<string, unknown>> {
    const value = requestRecord(
        request,
        ["additionalDirectoryIds", "booleanValue", "configId", "idempotencyKey", "value", "valueType"],
        "Conversation configuration request",
    );
    if (typeof value["booleanValue"] !== "boolean") {
        throw new MobiusValidationError("The Conversation configuration boolean value is invalid");
    }
    return {
        additionalDirectoryIds: identifiers(value["additionalDirectoryIds"], "additional directory", 16),
        booleanValue: value["booleanValue"],
        configId: identifier(value["configId"], "configuration"),
        idempotencyKey: identifier(value["idempotencyKey"], "configuration idempotency key"),
        value: boundedText(value["value"], "configuration value", 500, true),
        valueType: boundedText(value["valueType"], "configuration value type", 32),
    };
}

function serializedInitialConversationConfiguration(request: unknown): Readonly<Record<string, unknown>> {
    const value = requestRecord(
        request,
        ["additionalDirectoryIds", "booleanValue", "configId", "value", "valueType"],
        "initial Conversation configuration request",
    );
    if (typeof value["booleanValue"] !== "boolean") {
        throw new MobiusValidationError("The initial Conversation configuration boolean value is invalid");
    }
    return {
        additionalDirectoryIds: identifiers(value["additionalDirectoryIds"], "additional directory", 16),
        booleanValue: value["booleanValue"],
        configId: identifier(value["configId"], "configuration"),
        value: boundedText(value["value"], "configuration value", 500, true),
        valueType: boundedText(value["valueType"], "configuration value type", 32),
    };
}

function serializedCompletionPolicy(policy: MobiusBotCompletionPolicy): Readonly<Record<string, unknown>> {
    if (policy instanceof MobiusNoBotCompletionPolicy) {
        return { kind: "none" };
    }
    if (policy instanceof MobiusRequiredBotCompletionPolicy) {
        return {
            deliveryTargetId: identifier(policy.deliveryTargetId, "delivery target"),
            kind: "required",
            messageTemplate: boundedText(policy.messageTemplate, "completion message template", 10_000),
        };
    }
    throw new MobiusValidationError("The Bot completion policy is invalid");
}

export class MobiusBotOwnerClient {
    readonly #executor: BotRequestExecutor;
    readonly #projectId: string;

    constructor(options: MobiusBotOwnerClientOptions) {
        this.#projectId = identifier(options.projectId, "project");
        this.#executor = new BotRequestExecutor(
            options,
            new CredentialBotRequestAuthentication(options.credentialProvider),
            auditActorReference(options.actorReference),
        );
    }

    readonly listBots = async (signal: AbortSignal): Promise<MobiusBotDirectory> =>
        new MobiusBotDirectory(await this.#executor.get(projectBotsPath(this.#projectId), signal));

    readonly createBot = async (request: CreateMobiusBotRequest, signal: AbortSignal): Promise<MobiusBot> => {
        const value = requestRecord(request, ["avatarRef", "description", "displayName"], "Bot creation request");
        return decodeMobiusBot(
            await this.#executor.post(
                projectBotsPath(this.#projectId),
                {
                    avatarRef: boundedText(value["avatarRef"], "Bot avatar reference", 4_096, true),
                    description: boundedText(value["description"], "Bot description", 2_000, true),
                    displayName: boundedText(value["displayName"], "Bot display name", 80),
                },
                signal,
            ),
        );
    };

    readonly readBot = async (botId: string, signal: AbortSignal): Promise<MobiusBot> =>
        decodeMobiusBot(await this.#executor.get(projectBotPath(this.#projectId, botId, ""), signal));

    readonly reviseProfile = async (
        botId: string,
        request: ReviseMobiusBotProfileRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotProfileRevision> => {
        const value = requestRecord(
            request,
            ["avatarRef", "description", "displayName", "expectedRevision"],
            "Bot profile revision request",
        );
        return new MobiusBotProfileRevision(
            await this.#executor.post(
                projectBotPath(this.#projectId, botId, "profile-revisions"),
                {
                    avatarRef: boundedText(value["avatarRef"], "Bot avatar reference", 4_096, true),
                    description: boundedText(value["description"], "Bot description", 2_000, true),
                    displayName: boundedText(value["displayName"], "Bot display name", 80),
                    expectedRevision: boundedInteger(
                        value["expectedRevision"],
                        "Bot lifecycle revision",
                        1,
                        Number.MAX_SAFE_INTEGER,
                    ),
                },
                signal,
            ),
        );
    };

    readonly listBehaviors = async (botId: string, signal: AbortSignal): Promise<MobiusBotBehaviorDirectory> =>
        new MobiusBotBehaviorDirectory(
            await this.#executor.get(projectBotPath(this.#projectId, botId, "behavior-revisions"), signal),
        );

    readonly createBehavior = async (
        botId: string,
        request: CreateMobiusBotBehaviorRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotBehaviorRevision> => {
        const value = requestRecord(
            request,
            ["agentConfiguration", "expectedRevision", "instructions", "requiredCapabilities"],
            "Bot behavior request",
        );
        const configuration = value["agentConfiguration"];
        if (!isRecord(configuration)) {
            throw new MobiusValidationError("The Bot Agent configuration is invalid");
        }
        return decodeMobiusBotBehavior(
            await this.#executor.post(
                projectBotPath(this.#projectId, botId, "behavior-revisions"),
                {
                    agentConfiguration: Object.freeze(Object.fromEntries(Object.entries(configuration))),
                    expectedRevision: boundedInteger(
                        value["expectedRevision"],
                        "Bot behavior revision",
                        0,
                        Number.MAX_SAFE_INTEGER,
                    ),
                    instructions: boundedText(value["instructions"], "Bot behavior instructions", 100_000, true),
                    requiredCapabilities: identifiers(value["requiredCapabilities"], "Bot behavior capability", 32),
                },
                signal,
            ),
        );
    };

    readonly listBindings = async (botId: string, signal: AbortSignal): Promise<MobiusBotBindingDirectory> =>
        new MobiusBotBindingDirectory(
            await this.#executor.get(projectBotPath(this.#projectId, botId, "execution-bindings"), signal),
        );

    readonly readAgentConfiguration = async (
        botId: string,
        signal: AbortSignal,
    ): Promise<MobiusBotAgentConfiguration> =>
        new MobiusBotAgentConfiguration(
            await this.#executor.post(projectBotPath(this.#projectId, botId, "agent-configuration"), {}, signal),
        );

    readonly createBinding = async (
        botId: string,
        request: CreateMobiusBotBindingRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotBindingRequestAcceptance> => {
        const value = requestRecord(
            request,
            [
                "agentConfigRevision",
                "agentRef",
                "allowedDeliveryTargetIds",
                "behaviorRevisionId",
                "completionPolicy",
                "expectedRevision",
                "runtimeId",
                "workspaceRef",
            ],
            "Bot binding request",
        );
        const policy = value["completionPolicy"];
        if (!(policy instanceof MobiusBotCompletionPolicy)) {
            throw new MobiusValidationError("The Bot completion policy is invalid");
        }
        return new MobiusBotBindingRequestAcceptance(
            await this.#executor.post(
                projectBotPath(this.#projectId, botId, "execution-bindings"),
                {
                    agentConfigRevision: boundedInteger(
                        value["agentConfigRevision"],
                        "Agent configuration revision",
                        1,
                        Number.MAX_SAFE_INTEGER,
                    ),
                    agentRef: identifier(value["agentRef"], "Agent"),
                    allowedDeliveryTargetIds: identifiers(value["allowedDeliveryTargetIds"], "delivery target", 64),
                    behaviorRevisionId: identifier(value["behaviorRevisionId"], "Bot behavior"),
                    completionPolicy: serializedCompletionPolicy(policy),
                    expectedRevision: boundedInteger(
                        value["expectedRevision"],
                        "Bot lifecycle revision",
                        1,
                        Number.MAX_SAFE_INTEGER,
                    ),
                    runtimeId: identifier(value["runtimeId"], "Runtime"),
                    workspaceRef: boundedText(value["workspaceRef"], "Bot workspace", 2_048),
                },
                signal,
            ),
        );
    };

    readonly suspendBot = async (botId: string, expectedRevision: number, signal: AbortSignal): Promise<MobiusBot> =>
        await this.transitionBot(botId, "suspend", expectedRevision, signal);

    readonly resumeBot = async (botId: string, expectedRevision: number, signal: AbortSignal): Promise<MobiusBot> =>
        await this.transitionBot(botId, "resume", expectedRevision, signal);

    readonly archiveBot = async (botId: string, expectedRevision: number, signal: AbortSignal): Promise<MobiusBot> =>
        await this.transitionBot(botId, "archive", expectedRevision, signal);

    readonly listConversations = async (botId: string, signal: AbortSignal): Promise<MobiusBotConversationDirectory> =>
        new MobiusBotConversationDirectory(
            await this.#executor.get(projectBotPath(this.#projectId, botId, "conversations"), signal),
        );

    readonly createConversation = async (
        botId: string,
        request: CreateMobiusOwnerConversationRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotConversation> => {
        const value = requestRecord(request, ["clientConversationKey"], "owner Bot conversation request");
        return decodeMobiusOwnerBotConversation(
            await this.#executor.post(
                projectBotPath(this.#projectId, botId, "conversations"),
                {
                    clientConversationKey: identifier(value["clientConversationKey"], "client conversation"),
                },
                signal,
            ),
        );
    };

    readonly createProjectConversation = async (
        request: CreateMobiusProjectConversationRequest,
        signal: AbortSignal,
    ): Promise<MobiusProjectConversation> => {
        const value = requestRecord(
            request,
            ["botId", "clientReference", "configuration", "idempotencyKey", "title"],
            "Project Conversation request",
        );
        const configuration = value["configuration"];
        if (!isRecord(configuration)) {
            throw new MobiusValidationError("The initial Conversation configuration is invalid");
        }
        return new MobiusProjectConversation(
            await this.#executor.post(
                projectConversationsPath(this.#projectId),
                {
                    botId: identifier(value["botId"], "Bot"),
                    clientReference: identifier(value["clientReference"], "client reference"),
                    configuration: serializedInitialConversationConfiguration(configuration),
                    idempotencyKey: identifier(value["idempotencyKey"], "Conversation idempotency key"),
                    title: boundedText(value["title"], "Conversation title", 500, true),
                },
                signal,
            ),
        );
    };

    readonly readProjectConversation = async (
        conversationId: string,
        signal: AbortSignal,
    ): Promise<MobiusProjectConversation> =>
        new MobiusProjectConversation(
            await this.#executor.get(conversationPath(this.#projectId, conversationId, ""), signal),
        );

    readonly submitProjectConversationTurn = async (
        conversationId: string,
        request: SubmitMobiusProjectConversationTurnRequest,
        signal: AbortSignal,
    ): Promise<MobiusProjectConversationTurnAcceptance> => {
        const value = requestRecord(
            request,
            ["additionalDirectoryIds", "artifactIds", "content", "idempotencyKey", "images", "resources"],
            "Project Conversation turn request",
        );
        return new MobiusProjectConversationTurnAcceptance(
            await this.#executor.post(
                conversationPath(this.#projectId, conversationId, "turns"),
                {
                    additionalDirectoryIds: identifiers(value["additionalDirectoryIds"], "additional directory", 16),
                    artifactIds: identifiers(value["artifactIds"], "artifact", 16),
                    content: boundedText(value["content"], "Conversation Turn content", 100_000, true),
                    idempotencyKey: identifier(value["idempotencyKey"], "Turn idempotency key"),
                    images: decodePromptImagesValue(value["images"]),
                    resources: decodePromptResourcesValue(value["resources"]),
                },
                signal,
            ),
        );
    };

    readonly createConversationConfigurationRevision = async (
        conversationId: string,
        request: MobiusConversationConfigurationRequest,
        signal: AbortSignal,
    ): Promise<MobiusConversationConfigurationAcceptance> =>
        new MobiusConversationConfigurationAcceptance(
            await this.#executor.post(
                conversationPath(this.#projectId, conversationId, "configuration-revisions"),
                serializedConversationConfiguration(request),
                signal,
            ),
        );

    readonly submitMessage = async (
        botId: string,
        conversationId: string,
        request: SubmitMobiusOwnerBotMessageRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotTurnAcceptance> => {
        const value = requestRecord(
            request,
            ["actorRef", "artifactIds", "clientMessageId", "text"],
            "owner Bot message request",
        );
        return new MobiusBotTurnAcceptance(
            await this.#executor.post(
                projectBotPath(
                    this.#projectId,
                    botId,
                    `conversations/${encodeURIComponent(identifier(conversationId, "conversation"))}/messages`,
                ),
                {
                    actorRef: boundedText(value["actorRef"], "Bot actor reference", 500),
                    artifactIds: identifiers(value["artifactIds"], "artifact", 16),
                    clientMessageId: identifier(value["clientMessageId"], "client message"),
                    text: boundedText(value["text"], "Bot message text", 100_000, true),
                },
                signal,
            ),
        );
    };

    readonly readConversationEvents = async (
        botId: string,
        conversationId: string,
        after: string,
        signal: AbortSignal,
    ): Promise<MobiusBotConversationEventPage> => {
        const path = new URL(
            projectBotPath(
                this.#projectId,
                botId,
                `conversations/${encodeURIComponent(identifier(conversationId, "conversation"))}/events`,
            ),
            "https://mobius.invalid/",
        );
        if (after.length > 0) {
            path.searchParams.set("after", boundedText(after, "Bot event cursor", 512));
        }
        return new MobiusBotConversationEventPage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly readConversationMessages = async (
        botId: string,
        conversationId: string,
        page: MobiusPageRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotConversationMessagePage> => {
        const path = new URL(
            projectBotPath(
                this.#projectId,
                botId,
                `conversations/${encodeURIComponent(identifier(conversationId, "conversation"))}/messages`,
            ),
            "https://mobius.invalid/",
        );
        path.searchParams.set("limit", boundedInteger(page.limit, "message page limit", 1, 100).toString());
        if (page.cursor.length > 0) {
            path.searchParams.set("cursor", boundedText(page.cursor, "message cursor", 512));
        }
        return new MobiusBotConversationMessagePage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly cancelTurn = async (
        botId: string,
        turnId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<MobiusBotTurnCancellationAcceptance> =>
        new MobiusBotTurnCancellationAcceptance(
            await this.#executor.post(
                projectBotPath(
                    this.#projectId,
                    botId,
                    `turns/${encodeURIComponent(identifier(turnId, "turn"))}/cancel`,
                ),
                { idempotencyKey: identifier(idempotencyKey, "cancellation idempotency key") },
                signal,
            ),
        );

    readonly listConnections = async (botId: string, signal: AbortSignal): Promise<MobiusBotConnectionDirectory> =>
        new MobiusBotConnectionDirectory(
            await this.#executor.get(projectBotPath(this.#projectId, botId, "connections"), signal),
        );

    readonly createConnectionGrant = async (
        botId: string,
        request: CreateMobiusBotConnectionGrantRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotConnectionGrant> => {
        const value = requestRecord(
            request,
            ["audience", "expiresInSeconds", "label", "scopes"],
            "Bot connection grant request",
        );
        return new MobiusBotConnectionGrant(
            await this.#executor.post(
                projectBotPath(this.#projectId, botId, "connection-grants"),
                {
                    audience: identifier(value["audience"], "connector audience"),
                    expiresInSeconds: boundedInteger(value["expiresInSeconds"], "connection grant lifetime", 60, 3_600),
                    label: boundedText(value["label"], "connection label", 200),
                    scopes: identifiers(value["scopes"], "Bot connection scope", 32),
                },
                signal,
            ),
        );
    };

    readonly approveDeliveryTarget = async (
        botId: string,
        deliveryTargetId: string,
        expectedPolicyRevision: number,
        signal: AbortSignal,
    ): Promise<void> => {
        await this.#executor.post(
            projectBotPath(
                this.#projectId,
                botId,
                `delivery-targets/${encodeURIComponent(identifier(deliveryTargetId, "delivery target"))}/approve`,
            ),
            {
                expectedPolicyRevision: boundedInteger(
                    expectedPolicyRevision,
                    "delivery target policy revision",
                    0,
                    Number.MAX_SAFE_INTEGER,
                ),
            },
            signal,
        );
    };

    readonly revokeConnection = async (
        botId: string,
        connectionId: string,
        expectedRevision: number,
        signal: AbortSignal,
    ): Promise<MobiusRevokedBotConnection> =>
        new MobiusRevokedBotConnection(
            await this.#executor.post(
                projectBotPath(
                    this.#projectId,
                    botId,
                    `connections/${encodeURIComponent(identifier(connectionId, "connection"))}/revoke`,
                ),
                {
                    expectedRevision: boundedInteger(
                        expectedRevision,
                        "Bot connection revision",
                        1,
                        Number.MAX_SAFE_INTEGER,
                    ),
                },
                signal,
            ),
        );

    private readonly transitionBot = async (
        botId: string,
        action: string,
        expectedRevision: number,
        signal: AbortSignal,
    ): Promise<MobiusBot> =>
        decodeMobiusBot(
            await this.#executor.post(
                projectBotPath(this.#projectId, botId, action),
                {
                    expectedRevision: boundedInteger(
                        expectedRevision,
                        "Bot lifecycle revision",
                        1,
                        Number.MAX_SAFE_INTEGER,
                    ),
                },
                signal,
            ),
        );
}

function connectionPath(connectionId: string, resource: string): string {
    return `${MOBIUS_BOT_API_VERSION}/bot-connections/${encodeURIComponent(identifier(connectionId, "connection"))}/${resource}`;
}

export class MobiusBotConnectionResources {
    readonly #connectionId: string;
    readonly #executor: BotRequestExecutor;

    constructor(executor: BotRequestExecutor, connectionId: string) {
        this.#executor = executor;
        this.#connectionId = connectionId;
    }

    readonly rotateCredential = async (signal: AbortSignal): Promise<MobiusBotConnectionCredentialRotation> =>
        new MobiusBotConnectionCredentialRotation(
            await this.#executor.post(connectionPath(this.#connectionId, "credentials/rotate"), {}, signal),
        );

    readonly revoke = async (signal: AbortSignal): Promise<MobiusRevokedBotConnection> =>
        new MobiusRevokedBotConnection(
            await this.#executor.post(connectionPath(this.#connectionId, "revoke"), {}, signal),
        );
}

export class MobiusBotDeliveryTargetResources {
    readonly #connectionId: string;
    readonly #executor: BotRequestExecutor;

    constructor(executor: BotRequestExecutor, connectionId: string) {
        this.#executor = executor;
        this.#connectionId = connectionId;
    }

    readonly create = async (
        request: CreateMobiusBotDeliveryTargetRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryTarget> => {
        const value = requestRecord(request, ["alias"], "Bot delivery target request");
        return new MobiusBotDeliveryTarget(
            await this.#executor.post(
                connectionPath(this.#connectionId, "delivery-targets"),
                { alias: identifier(value["alias"], "delivery target alias") },
                signal,
            ),
        );
    };

    readonly disable = async (
        deliveryTargetId: string,
        signal: AbortSignal,
    ): Promise<MobiusDisabledBotDeliveryTarget> =>
        new MobiusDisabledBotDeliveryTarget(
            await this.#executor.post(
                connectionPath(
                    this.#connectionId,
                    `delivery-targets/${encodeURIComponent(identifier(deliveryTargetId, "delivery target"))}/disable`,
                ),
                {},
                signal,
            ),
        );
}

export class MobiusBotConversationResources {
    readonly #executor: BotRequestExecutor;
    readonly #projectId: string;

    constructor(executor: BotRequestExecutor, projectId: string) {
        this.#executor = executor;
        this.#projectId = projectId;
    }

    readonly create = async (
        botId: string,
        request: CreateMobiusConnectedConversationRequest,
        signal: AbortSignal,
    ): Promise<MobiusConnectedBotConversation> => {
        const value = requestRecord(
            request,
            ["clientConversationKey", "replyDeliveryTargetId", "title"],
            "connected Bot conversation request",
        );
        return new MobiusConnectedBotConversation(
            await this.#executor.post(
                projectBotPath(this.#projectId, botId, "conversations"),
                {
                    clientConversationKey: identifier(value["clientConversationKey"], "client conversation"),
                    replyDeliveryTargetId: identifier(value["replyDeliveryTargetId"], "reply delivery target"),
                    title: boundedText(value["title"], "Bot conversation title", 500, true),
                },
                signal,
            ),
        );
    };

    readonly submitMessage = async (
        botId: string,
        conversationId: string,
        request: SubmitMobiusBotMessageRequest,
        signal: AbortSignal,
    ): Promise<MobiusBotTurnAcceptance> => {
        const value = requestRecord(
            request,
            ["actorRef", "clientMessageId", "resourceRefs", "text"],
            "Bot message request",
        );
        return new MobiusBotTurnAcceptance(
            await this.#executor.post(
                projectBotPath(
                    this.#projectId,
                    botId,
                    `conversations/${encodeURIComponent(identifier(conversationId, "conversation"))}/messages`,
                ),
                {
                    actorRef: boundedText(value["actorRef"], "external actor reference", 500),
                    clientMessageId: identifier(value["clientMessageId"], "client message"),
                    resourceRefs: identifiers(value["resourceRefs"], "resource reference", 16),
                    text: boundedText(value["text"], "Bot message text", 100_000),
                },
                signal,
            ),
        );
    };

    readonly readEvents = async (
        botId: string,
        conversationId: string,
        after: string,
        signal: AbortSignal,
    ): Promise<MobiusBotConversationEventPage> => {
        const path = new URL(
            projectBotPath(
                this.#projectId,
                botId,
                `conversations/${encodeURIComponent(identifier(conversationId, "conversation"))}/events`,
            ),
            "https://mobius.invalid/",
        );
        if (after.length > 0) {
            path.searchParams.set("after", boundedText(after, "Bot event cursor", 512));
        }
        return new MobiusBotConversationEventPage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly cancelTurn = async (
        botId: string,
        turnId: string,
        idempotencyKey: string,
        signal: AbortSignal,
    ): Promise<MobiusBotTurnCancellationAcceptance> =>
        new MobiusBotTurnCancellationAcceptance(
            await this.#executor.post(
                projectBotPath(
                    this.#projectId,
                    botId,
                    `turns/${encodeURIComponent(identifier(turnId, "turn"))}/cancel`,
                ),
                { idempotencyKey: identifier(idempotencyKey, "cancellation idempotency key") },
                signal,
            ),
        );
}

export class MobiusBotOutboundMessageResources {
    readonly #connectionId: string;
    readonly #executor: BotRequestExecutor;

    constructor(executor: BotRequestExecutor, connectionId: string) {
        this.#executor = executor;
        this.#connectionId = connectionId;
    }

    readonly read = async (after: number, limit: number, signal: AbortSignal): Promise<MobiusBotOutboundEventPage> => {
        const path = new URL(connectionPath(this.#connectionId, "outbound-events"), "https://mobius.invalid/");
        path.searchParams.set("after", boundedInteger(after, "outbound cursor", 0, Number.MAX_SAFE_INTEGER).toString());
        path.searchParams.set("limit", boundedInteger(limit, "outbound page limit", 1, 100).toString());
        return new MobiusBotOutboundEventPage(
            await this.#executor.get(`${path.pathname.slice(1)}${path.search}`, signal),
        );
    };

    readonly delivered = async (
        outboundMessageId: string,
        claimId: string,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        await this.acknowledge(outboundMessageId, "delivered", { claimId: identifier(claimId, "claim") }, signal);

    readonly retryableFailure = async (
        outboundMessageId: string,
        claimId: string,
        code: string,
        retryAfterSeconds: number,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        await this.acknowledge(
            outboundMessageId,
            "retryable-failure",
            {
                claimId: identifier(claimId, "claim"),
                code: identifier(code, "failure code"),
                retryAfterSeconds: boundedInteger(retryAfterSeconds, "retry delay", 1, 3_600),
            },
            signal,
        );

    readonly terminalFailure = async (
        outboundMessageId: string,
        claimId: string,
        code: string,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        await this.acknowledge(
            outboundMessageId,
            "terminal-failure",
            { claimId: identifier(claimId, "claim"), code: identifier(code, "failure code") },
            signal,
        );

    private readonly acknowledge = async (
        outboundMessageId: string,
        outcome: string,
        body: Readonly<Record<string, unknown>>,
        signal: AbortSignal,
    ): Promise<MobiusBotDeliveryAcknowledgement> =>
        new MobiusBotDeliveryAcknowledgement(
            await this.#executor.post(
                connectionPath(
                    this.#connectionId,
                    `outbound-messages/${encodeURIComponent(identifier(outboundMessageId, "outbound message"))}/${outcome}`,
                ),
                body,
                signal,
            ),
        );
}

export class MobiusBotConnectorClient {
    readonly connection: MobiusBotConnectionResources;
    readonly conversations: MobiusBotConversationResources;
    readonly deliveryTargets: MobiusBotDeliveryTargetResources;
    readonly outboundMessages: MobiusBotOutboundMessageResources;

    constructor(options: MobiusBotConnectorClientOptions) {
        const connectionId = identifier(options.connectionId, "connection");
        const projectId = identifier(options.projectId, "project");
        const executor = new BotRequestExecutor(
            options,
            new CredentialBotRequestAuthentication(options.credentialProvider),
            "",
        );
        this.connection = new MobiusBotConnectionResources(executor, connectionId);
        this.conversations = new MobiusBotConversationResources(executor, projectId);
        this.deliveryTargets = new MobiusBotDeliveryTargetResources(executor, connectionId);
        this.outboundMessages = new MobiusBotOutboundMessageResources(executor, connectionId);
    }
}

export function createMobiusBotConnectorClient(options: MobiusBotConnectorClientOptions): MobiusBotConnectorClient {
    return new MobiusBotConnectorClient(options);
}

export async function redeemMobiusBotConnectionGrant(
    options: MobiusBotApiOptions,
    request: RedeemMobiusBotConnectionGrantRequest,
    signal: AbortSignal,
): Promise<MobiusBotConnectionCredential> {
    const value = requestRecord(
        request,
        ["audience", "connectorPrincipalId", "grantId", "grantSecret"],
        "Bot connection grant redemption",
    );
    const executor = new BotRequestExecutor(options, new AnonymousBotRequestAuthentication(), "");
    return new MobiusBotConnectionCredential(
        await executor.post(
            `${MOBIUS_BOT_API_VERSION}/bot-connection-grants/redeem`,
            {
                audience: identifier(value["audience"], "connector audience"),
                connectorPrincipalId: boundedText(value["connectorPrincipalId"], "connector principal", 500),
                grantId: identifier(value["grantId"], "connection grant"),
                grantSecret: token(value["grantSecret"], "connection grant secret"),
            },
            signal,
        ),
    );
}
