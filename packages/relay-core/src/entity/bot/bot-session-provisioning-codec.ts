import {
    type BotCompletionDeliveryPolicy,
    BotConnectionReplyRoute,
    BotDeliveryTargetReference,
    type BotReplyRoute,
    DEFAULT_AGENT_EXECUTION_CONFIGURATION,
    decodeAgentExecutionConfiguration,
    decodeSessionConfigurationSelections,
    NoBotCompletionDeliveryPolicy,
    OwnerBotReplyRoute,
    RequiredBotCompletionDeliveryPolicy,
    type SessionConfigurationSelection,
} from "@moxt-ai/mobius-protocol";
import { isSessionDirectoryIdentifier } from "../do/session.ts";
import { BotSessionProvisioning, BotSessionRuntimeError } from "./bot-session.ts";

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function invalid(message: string, options: ErrorOptions = {}): BotSessionRuntimeError {
    return new BotSessionRuntimeError("session_storage_unavailable", message, options);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Readonly<Record<string, unknown>>, fields: readonly string[]): void {
    const keys = Object.keys(value);
    if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
        throw invalid("The Bot conversation provisioning fields are invalid");
    }
}

function exactWithOptional(
    value: Readonly<Record<string, unknown>>,
    fields: readonly string[],
    optionalFields: readonly string[],
): void {
    const keys = Object.keys(value);
    if (
        keys.length < fields.length ||
        keys.length > fields.length + optionalFields.length ||
        fields.some((field) => !Object.hasOwn(value, field)) ||
        keys.some((key) => !fields.includes(key) && !optionalFields.includes(key))
    ) {
        throw invalid("The Bot conversation provisioning fields are invalid");
    }
}

function text(
    value: Readonly<Record<string, unknown>>,
    key: string,
    maximumLength: number,
    allowEmpty = false,
): string {
    const field = value[key];
    if (typeof field !== "string" || field.length > maximumLength || (!allowEmpty && field.length === 0)) {
        throw invalid(`The Bot conversation provisioning ${key} is invalid`);
    }
    return field;
}

function identifier(value: Readonly<Record<string, unknown>>, key: string): string {
    const field = text(value, key, 128);
    if (!IDENTIFIER_PATTERN.test(field)) {
        throw invalid(`The Bot conversation provisioning ${key} is invalid`);
    }
    return field;
}

function positiveInteger(value: Readonly<Record<string, unknown>>, key: string): number {
    const field = value[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 1) {
        throw invalid(`The Bot conversation provisioning ${key} is invalid`);
    }
    return field;
}

function targets(value: unknown): readonly BotDeliveryTargetReference[] {
    if (!Array.isArray(value) || value.length > 64) {
        throw invalid("The Bot conversation provisioning targets are invalid");
    }
    const aliases = new Set<string>();
    const identifiers = new Set<string>();
    const decoded: BotDeliveryTargetReference[] = [];
    for (const candidate of value) {
        if (!isRecord(candidate)) {
            throw invalid("The Bot conversation provisioning targets are invalid");
        }
        exact(candidate, ["alias", "deliveryTargetId"]);
        const alias = identifier(candidate, "alias");
        const deliveryTargetId = identifier(candidate, "deliveryTargetId");
        if (aliases.has(alias) || identifiers.has(deliveryTargetId)) {
            throw invalid("The Bot conversation provisioning targets are invalid");
        }
        aliases.add(alias);
        identifiers.add(deliveryTargetId);
        decoded.push(new BotDeliveryTargetReference(alias, deliveryTargetId));
    }
    return Object.freeze(decoded);
}

function completionPolicy(value: unknown): BotCompletionDeliveryPolicy {
    if (!isRecord(value)) {
        throw invalid("The Bot conversation provisioning completion policy is invalid");
    }
    if (value["kind"] === "none") {
        exact(value, ["kind"]);
        return new NoBotCompletionDeliveryPolicy();
    }
    if (value["kind"] === "required") {
        exact(value, ["deliveryTargetId", "kind", "messageTemplate"]);
        return new RequiredBotCompletionDeliveryPolicy(
            identifier(value, "deliveryTargetId"),
            text(value, "messageTemplate", 10_000),
        );
    }
    throw invalid("The Bot conversation provisioning completion policy is invalid");
}

function replyRoute(value: unknown): BotReplyRoute {
    if (!isRecord(value)) {
        throw invalid("The Bot conversation provisioning reply route is invalid");
    }
    if (value["kind"] === "owner") {
        exact(value, ["kind"]);
        return new OwnerBotReplyRoute();
    }
    if (value["kind"] === "connection") {
        exact(value, ["connectionId", "deliveryTargetId", "kind"]);
        return new BotConnectionReplyRoute(identifier(value, "connectionId"), identifier(value, "deliveryTargetId"));
    }
    throw invalid("The Bot conversation provisioning reply route is invalid");
}

function sessionConfigurations(value: unknown): readonly SessionConfigurationSelection[] {
    try {
        return decodeSessionConfigurationSelections(value);
    } catch (cause) {
        throw invalid("The Bot conversation provisioning configuration is invalid", { cause });
    }
}

function executionConfiguration(value: unknown) {
    try {
        return decodeAgentExecutionConfiguration(value);
    } catch (cause) {
        throw invalid("The Bot conversation execution configuration is invalid", { cause });
    }
}

export function decodeBotSessionProvisioning(value: unknown): BotSessionProvisioning {
    if (!isRecord(value)) {
        throw invalid("The Bot conversation provisioning is invalid");
    }
    exactWithOptional(
        value,
        [
            "agentConfigRevision",
            "agentRef",
            "allowedDeliveryTargets",
            "behaviorDigest",
            "behaviorInstructions",
            "behaviorRevisionId",
            "bindingId",
            "bindingRevision",
            "botId",
            "completionPolicy",
            "conversationId",
            "creatorKind",
            "creatorPrincipalId",
            "localGrantId",
            "replyRoute",
            "runtimeId",
            "sessionId",
            "title",
            "workspaceRef",
        ],
        ["executionConfiguration", "sessionConfigurations"],
    );
    const creatorKind = text(value, "creatorKind", 32);
    if (creatorKind !== "owner" && creatorKind !== "connection") {
        throw invalid("The Bot conversation provisioning creator kind is invalid");
    }
    const workspaceRef = text(value, "workspaceRef", 2_048);
    if (!isSessionDirectoryIdentifier(workspaceRef)) {
        throw invalid("The Bot conversation provisioning workspace is invalid");
    }
    const behaviorDigest = text(value, "behaviorDigest", 64);
    if (!SHA256_PATTERN.test(behaviorDigest)) {
        throw invalid("The Bot conversation provisioning behavior digest is invalid");
    }
    const policy = completionPolicy(value["completionPolicy"]);
    const route = replyRoute(value["replyRoute"]);
    if (creatorKind === "owner" && !(route instanceof OwnerBotReplyRoute)) {
        throw invalid("The Bot conversation provisioning reply route does not match its creator");
    }
    if (creatorKind === "connection" && !(route instanceof BotConnectionReplyRoute)) {
        throw invalid("The Bot conversation provisioning reply route does not match its creator");
    }
    return new BotSessionProvisioning(
        identifier(value, "sessionId"),
        identifier(value, "conversationId"),
        identifier(value, "botId"),
        identifier(value, "behaviorRevisionId"),
        identifier(value, "bindingId"),
        positiveInteger(value, "bindingRevision"),
        identifier(value, "runtimeId"),
        identifier(value, "agentRef"),
        workspaceRef,
        positiveInteger(value, "agentConfigRevision"),
        identifier(value, "localGrantId"),
        creatorKind,
        text(value, "creatorPrincipalId", 500),
        text(value, "title", 500, true),
        text(value, "behaviorInstructions", 100_000, true),
        behaviorDigest,
        targets(value["allowedDeliveryTargets"]),
        policy,
        route,
        value["executionConfiguration"] === undefined
            ? DEFAULT_AGENT_EXECUTION_CONFIGURATION
            : executionConfiguration(value["executionConfiguration"]),
        value["sessionConfigurations"] === undefined ? [] : sessionConfigurations(value["sessionConfigurations"]),
    );
}

export function encodeBotSessionProvisioning(provisioning: BotSessionProvisioning): string {
    let value: unknown;
    try {
        value = JSON.parse(JSON.stringify(provisioning));
    } catch (cause) {
        throw invalid("The Bot conversation provisioning could not be encoded", { cause });
    }
    return JSON.stringify(decodeBotSessionProvisioning(value));
}
