import {
    type AgentExecutionConfiguration,
    type BotCompletionDeliveryPolicy,
    type BotDeliveryTargetReference,
    decodeAgentExecutionConfiguration,
    decodeSessionConfigurationSelections,
    NoBotCompletionDeliveryPolicy,
    RequiredBotCompletionDeliveryPolicy,
    type SessionConfigurationSelection,
} from "@moxt-ai/mobius-protocol";
import { BotApiError } from "./bot-error.ts";

export interface ActiveBindingContext {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly allowedDeliveryTargets: readonly BotDeliveryTargetReference[];
    readonly behaviorDigest: string;
    readonly behaviorInstructions: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly botId: string;
    readonly completionPolicy: BotCompletionDeliveryPolicy;
    readonly executionConfiguration: AgentExecutionConfiguration;
    readonly runtimeId: string;
    readonly sessionConfigurations: readonly SessionConfigurationSelection[];
    readonly workspaceRef: string;
}

export function executionConfiguration(encoded: string): AgentExecutionConfiguration {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The execution configuration is invalid", "unavailable", {
            cause,
        });
    }
    try {
        return decodeAgentExecutionConfiguration(value);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The execution configuration is invalid", "unavailable", {
            cause,
        });
    }
}

export interface BotExecutionBindingActivation {
    readonly agentConfigRevision: number;
    readonly agentRef: string;
    readonly behaviorRevisionId: string;
    readonly bindingId: string;
    readonly bindingRevision: number;
    readonly completionPolicy: BotCompletionDeliveryPolicy;
    readonly executionConfiguration: AgentExecutionConfiguration;
    readonly runtimeId: string;
    readonly workspaceRef: string;
}

export function sessionConfigurations(encodedConfiguration: string): readonly SessionConfigurationSelection[] {
    let configuration: unknown;
    try {
        configuration = JSON.parse(encodedConfiguration);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The behavior configuration is invalid", "unavailable", {
            cause,
        });
    }
    if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration)) {
        throw new BotApiError("bot_service_unavailable", "The behavior configuration is invalid", "unavailable");
    }
    const value = Reflect.get(configuration, "sessionConfigurations");
    if (value === undefined) {
        return [];
    }
    try {
        return decodeSessionConfigurationSelections(value);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The behavior configuration is invalid", "unavailable", {
            cause,
        });
    }
}

export function stringArray(encoded: string, message: string): readonly string[] {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", message, "unavailable", { cause });
    }
    if (!Array.isArray(value) || value.some((candidate) => typeof candidate !== "string")) {
        throw new BotApiError("bot_service_unavailable", message, "unavailable");
    }
    return value.filter((candidate) => typeof candidate === "string");
}

export function completionPolicy(encoded: string): BotCompletionDeliveryPolicy {
    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (cause) {
        throw new BotApiError("bot_service_unavailable", "The completion policy is invalid", "unavailable", { cause });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new BotApiError("bot_service_unavailable", "The completion policy is invalid", "unavailable");
    }
    if (Reflect.get(value, "kind") === "none" && Object.keys(value).length === 1) {
        return new NoBotCompletionDeliveryPolicy();
    }
    if (
        Reflect.get(value, "kind") === "required" &&
        typeof Reflect.get(value, "deliveryTargetId") === "string" &&
        typeof Reflect.get(value, "messageTemplate") === "string" &&
        Object.keys(value).length === 3
    ) {
        return new RequiredBotCompletionDeliveryPolicy(
            Reflect.get(value, "deliveryTargetId"),
            Reflect.get(value, "messageTemplate"),
        );
    }
    throw new BotApiError("bot_service_unavailable", "The completion policy is invalid", "unavailable");
}
