import {
    type BotCompletionDeliveryPolicy,
    NoBotCompletionDeliveryPolicy,
    RequiredBotCompletionDeliveryPolicy,
    SessionPromptDisposition,
} from "@moxt-ai/mobius-protocol";
import { BotApiError } from "../../entity/bot/bot-error.ts";
import type { NewBotConversation, NewBotMessage } from "../../service/bot/bot-service.ts";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DIRECTORY_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,2047}$/;
const TOKEN = /^[a-zA-Z0-9_-]{32,256}$/;
const SCOPES = new Set([
    "conversation-events:read",
    "inbound-conversation:create",
    "inbound-message:create",
    "outbound-message:ack",
    "outbound-message:read",
    "turn:cancel",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw new BotApiError("invalid_request", "The request fields are invalid", "invalid-input");
    }
}

export function exactBody(
    value: Readonly<Record<string, unknown>>,
    fields: readonly string[],
): Readonly<Record<string, unknown>> {
    exact(value, fields);
    return value;
}

export interface ConversationConfigurationInput {
    readonly additionalDirectoryIds: readonly string[];
    readonly booleanValue: boolean;
    readonly configId: string;
    readonly value: string;
    readonly valueType: "boolean" | "select";
}

export function conversationConfiguration(
    value: Readonly<Record<string, unknown>>,
    key = "configuration",
): ConversationConfigurationInput {
    const configuration = object(value, key);
    exact(configuration, ["additionalDirectoryIds", "booleanValue", "configId", "value", "valueType"]);
    const valueType = string(configuration, "valueType", 32);
    if (valueType !== "boolean" && valueType !== "select") {
        throw new BotApiError("invalid_request", "The valueType field is invalid", "invalid-input");
    }
    return {
        additionalDirectoryIds: identifiers(configuration, "additionalDirectoryIds", 16),
        booleanValue: boolean(configuration, "booleanValue"),
        configId: identifier(configuration, "configId"),
        value: string(configuration, "value", 500, true),
        valueType,
    };
}
export function string(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    allowEmpty = false,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.trim().length === 0)) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, "invalid-input");
    }
    return field;
}
export function identifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = string(value, key, 128);
    if (!IDENTIFIER.test(field)) {
        throw new BotApiError("invalid_request", `The ${key} identifier is invalid`, "invalid-input");
    }
    return field;
}
export function directoryIdentifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = string(value, key, 2_048);
    if (!DIRECTORY_IDENTIFIER.test(field)) {
        throw new BotApiError("invalid_request", `The ${key} directory identifier is invalid`, "invalid-input");
    }
    return field;
}
export function pathIdentifier(value: string): string {
    if (!IDENTIFIER.test(value)) {
        throw new BotApiError("invalid_request", "The path identifier is invalid", "invalid-input");
    }
    return value;
}
export function integer(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, "invalid-input");
    }
    return field;
}
export function boolean(value: Readonly<Record<string, unknown>>, key: string): boolean {
    const field = value[key];
    if (typeof field !== "boolean") {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, "invalid-input");
    }
    return field;
}
export function positiveInteger(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = integer(value, key);
    if (field < 1) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, "invalid-input");
    }
    return field;
}
export function object(value: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> {
    const field = value[key];
    if (!isRecord(field)) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, "invalid-input");
    }
    return Object.fromEntries(Object.entries(field));
}
export function identifiers(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumCount: number,
): readonly string[] {
    const field = value[key];
    if (!Array.isArray(field) || field.length > maximumCount) {
        throw new BotApiError("invalid_request", `The ${key} field is invalid`, "invalid-input");
    }
    const result: string[] = [];
    for (const item of field) {
        if (typeof item !== "string" || !IDENTIFIER.test(item) || result.includes(item)) {
            throw new BotApiError("invalid_request", `The ${key} field is invalid`, "invalid-input");
        }
        result.push(item);
    }
    return result;
}
export function connectorScopes(value: Readonly<Record<string, unknown>>): readonly string[] {
    const scopes = identifiers(value, "scopes", SCOPES.size);
    if (scopes.length === 0 || scopes.some((scope) => !SCOPES.has(scope))) {
        throw new BotApiError("invalid_request", "The Bot connection scopes are invalid", "invalid-input");
    }
    return scopes;
}
export function completionPolicy(value: Readonly<Record<string, unknown>>): BotCompletionDeliveryPolicy {
    const policy = object(value, "completionPolicy");
    if (policy["kind"] === "none") {
        exact(policy, ["kind"]);
        return new NoBotCompletionDeliveryPolicy();
    }
    if (policy["kind"] === "required") {
        exact(policy, ["deliveryTargetId", "kind", "messageTemplate"]);
        return new RequiredBotCompletionDeliveryPolicy(
            identifier(policy, "deliveryTargetId"),
            string(policy, "messageTemplate", 10_000),
        );
    }
    throw new BotApiError("invalid_request", "The completionPolicy field is invalid", "invalid-input");
}
export function conversationRequest(value: Readonly<Record<string, unknown>>): NewBotConversation {
    if (Object.hasOwn(value, "replyDeliveryTargetId")) {
        exact(value, ["clientConversationKey", "title", "replyDeliveryTargetId"]);
        return {
            kind: "connection",
            clientConversationKey: identifier(value, "clientConversationKey"),
            title: string(value, "title", 500, true),
            replyDeliveryTargetId: identifier(value, "replyDeliveryTargetId"),
        };
    }
    exact(value, ["clientConversationKey"]);
    return {
        kind: "owner",
        clientConversationKey: identifier(value, "clientConversationKey"),
    };
}
export function messageRequest(value: Readonly<Record<string, unknown>>): NewBotMessage {
    if (Object.hasOwn(value, "artifactIds")) {
        exact(value, ["actorRef", "artifactIds", "clientMessageId", "text"]);
        const artifactIds = identifiers(value, "artifactIds", 16);
        const text = string(value, "text", 100_000, true);
        if (text.trim().length === 0 && artifactIds.length === 0) {
            throw new BotApiError("invalid_request", "The Bot message has no content", "invalid-input");
        }
        return {
            kind: "owner",
            clientMessageId: identifier(value, "clientMessageId"),
            actorRef: string(value, "actorRef", 500),
            text,
            artifactIds,
        };
    }
    exact(value, ["actorRef", "clientMessageId", "resourceRefs", "text"]);
    return {
        kind: "connection",
        clientMessageId: identifier(value, "clientMessageId"),
        actorRef: string(value, "actorRef", 500),
        text: string(value, "text", 100_000),
        resourceRefs: identifiers(value, "resourceRefs", 16),
    };
}
export function bearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
        throw new BotApiError("credential_invalid", "A bearer credential is required", "unauthenticated");
    }
    const token = header.slice(7);
    if (!TOKEN.test(token)) {
        throw new BotApiError("credential_invalid", "The bearer credential is invalid", "unauthenticated");
    }
    return token;
}
export function actorReference(request: Request): string {
    return request.headers.get("x-mobius-actor-ref") ?? "";
}
export function executionCapability(request: Request): string {
    const token = request.headers.get("x-mobius-bot-execution-capability") ?? "";
    if (!TOKEN.test(token)) {
        throw new BotApiError(
            "execution_context_required",
            "A Bot execution capability is required",
            "unauthenticated",
        );
    }
    return token;
}
export function cursor(url: URL): number {
    const value = url.searchParams.get("after") ?? "0";
    if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new BotApiError("invalid_request", "The outbound cursor is invalid", "invalid-input");
    }
    return Number(value);
}
export function pageLimit(url: URL): number {
    const value = url.searchParams.get("limit") ?? "100";
    if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) {
        throw new BotApiError("invalid_request", "The page limit is invalid", "invalid-input");
    }
    return Number(value);
}

export function messageCursor(url: URL): string {
    const value = url.searchParams.get("cursor") ?? "";
    if (value.length > 512) {
        throw new BotApiError("invalid_request", "The message cursor is invalid", "invalid-input");
    }
    return value;
}

export function messagePageLimit(url: URL): number {
    const value = url.searchParams.get("limit") ?? "50";
    if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) {
        throw new BotApiError("invalid_request", "The message page limit is invalid", "invalid-input");
    }
    return Number(value);
}

export function turnDisposition(value: Readonly<Record<string, unknown>>): string {
    const disposition = string(value, "disposition", 16);
    if (disposition !== SessionPromptDisposition.Queue && disposition !== SessionPromptDisposition.Steer) {
        throw new BotApiError("invalid_request", "The Turn disposition is invalid", "invalid-input");
    }
    return disposition;
}

export function steeringDisposition(value: Readonly<Record<string, unknown>>): string {
    const disposition = turnDisposition(value);
    if (disposition !== SessionPromptDisposition.Steer) {
        throw new BotApiError("invalid_request", "Only steering promotion is supported", "invalid-input");
    }
    return disposition;
}

export function eventWaitMilliseconds(url: URL): number {
    const value = url.searchParams.get("wait") ?? "0";
    if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 10_000) {
        throw new BotApiError("invalid_request", "The event wait is invalid", "invalid-input");
    }
    return Number(value);
}
