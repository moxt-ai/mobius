import type { SessionConfigOption, SessionConfigValue } from "@moxt-ai/mobius-protocol";

import {
    AGENT_DEFAULT_REASONING_EFFORT,
    isRecord,
    normalizeConfigOptions,
    readString,
    type SessionConfigChange,
    type SessionConfigProtocol,
    SessionConfigProtocolError,
    type SessionConfigTransport,
    standardSessionConfigProtocol,
} from "./session-config-protocol.ts";

const LEGACY_MODEL_CONFIG_ID = "grok_build_legacy_model";
const LEGACY_REASONING_EFFORT_CONFIG_ID = "grok_build_legacy_reasoning_effort";

function legacyOptions(response: unknown): readonly Readonly<Record<string, unknown>>[] {
    if (!isRecord(response)) {
        return [];
    }
    const metadata = response["_meta"];
    if (!isRecord(metadata)) {
        return [];
    }
    const sessionConfig = metadata["x.ai/sessionConfig"];
    if (!isRecord(sessionConfig) || !Array.isArray(sessionConfig["options"])) {
        return [];
    }
    return sessionConfig["options"].slice(0, 500).filter(isRecord);
}

function legacyValue(option: Readonly<Record<string, unknown>>): SessionConfigValue {
    const value = readString(option["id"]);
    return {
        description: readString(option["description"]).slice(0, 500),
        groupId: "",
        groupName: "",
        name: readString(option["label"], value).slice(0, 255),
        value: value.slice(0, 500),
    };
}

function modelsRecord(response: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(response) || !isRecord(response["models"])) {
        return {};
    }
    return response["models"];
}

function legacyModelOptions(response: unknown): readonly SessionConfigOption[] {
    const options = legacyOptions(response);
    const models = modelsRecord(response);
    const values: SessionConfigValue[] = [];
    for (const option of options) {
        if (option["category"] === "model") {
            const value = legacyValue(option);
            if (value.value.length > 0 && !values.some((existing) => existing.value === value.value)) {
                values.push(value);
            }
        }
    }
    if (values.length === 0 && Array.isArray(models["availableModels"])) {
        for (const model of models["availableModels"]) {
            if (!isRecord(model)) {
                continue;
            }
            const value = readString(model["modelId"]).slice(0, 500);
            if (value.length === 0) {
                continue;
            }
            if (!values.some((existing) => existing.value === value)) {
                values.push({
                    description: "",
                    groupId: "",
                    groupName: "",
                    name: readString(model["name"], value).slice(0, 255),
                    value,
                });
            }
        }
    }
    const selected = options.find((option) => option["category"] === "model" && option["selected"] === true);
    const currentValue = readString(
        models["currentModelId"],
        selected === undefined ? "" : readString(selected["id"]),
    ).slice(0, 500);
    if (values.length === 0 || !values.some((value) => value.value === currentValue)) {
        return [];
    }
    const result: SessionConfigOption = {
        booleanValue: false,
        category: "model",
        currentValue,
        description: "Model used by Grok Build",
        id: LEGACY_MODEL_CONFIG_ID,
        name: "Model",
        type: "select",
        values: values.slice(0, 500),
    };
    return [result];
}

function legacyReasoningEffortOptions(response: unknown): readonly SessionConfigOption[] {
    const options = legacyOptions(response);
    const values: SessionConfigValue[] = [];
    for (const option of options) {
        if (option["category"] !== "mode") {
            continue;
        }
        const value = legacyValue(option);
        if (value.value.length > 0 && !values.some((existing) => existing.value === value.value)) {
            values.push(value);
        }
    }
    if (values.length === 0) {
        return [];
    }
    const selected = options.find((option) => option["category"] === "mode" && option["selected"] === true);
    if (selected === undefined) {
        values.unshift({
            description: "Use the selected model's default reasoning effort",
            groupId: "",
            groupName: "",
            name: "Agent default",
            value: AGENT_DEFAULT_REASONING_EFFORT,
        });
    }
    const currentValue =
        selected === undefined
            ? AGENT_DEFAULT_REASONING_EFFORT
            : readString(selected["id"], AGENT_DEFAULT_REASONING_EFFORT);
    if (!values.some((value) => value.value === currentValue)) {
        return [];
    }
    const result: SessionConfigOption = {
        booleanValue: false,
        category: "thought_level",
        currentValue,
        description: "Reasoning effort used by Grok Build",
        id: LEGACY_REASONING_EFFORT_CONFIG_ID,
        name: "Reasoning effort",
        type: "select",
        values: values.slice(0, 500),
    };
    return [result];
}

function normalizeGrokLifecycle(response: unknown): readonly SessionConfigOption[] {
    const lifecycle = isRecord(response) ? response : {};
    const standard = normalizeConfigOptions(lifecycle["configOptions"], lifecycle["modes"]);
    const normalized = [...standard];
    if (!normalized.some((option) => option.category === "model")) {
        normalized.push(...legacyModelOptions(response));
    }
    if (!normalized.some((option) => option.category === "thought_level")) {
        const efforts = legacyReasoningEffortOptions(response);
        if (efforts.length > 0) {
            const modelIndex = normalized.findIndex((option) => option.category === "model");
            normalized.splice(modelIndex < 0 ? normalized.length : modelIndex + 1, 0, ...efforts);
        }
    }
    return normalized.slice(0, 100);
}

function updateCurrentValue(
    current: readonly SessionConfigOption[],
    category: string,
    value: string,
): readonly SessionConfigOption[] {
    return current.map((option) => (option.category === category ? { ...option, currentValue: value } : option));
}

function validateGrokResponse(response: unknown, modelId: string): void {
    if (!isRecord(response) || !isRecord(response["_meta"])) {
        throw new SessionConfigProtocolError("Grok Build returned an invalid session configuration response");
    }
    const model = response["_meta"]["model"];
    const appliedModel = isRecord(model) ? model["Ok"] : model;
    if (appliedModel !== modelId) {
        throw new SessionConfigProtocolError("Grok Build returned an invalid session configuration response");
    }
}

class GrokBuildSessionConfigProtocol implements SessionConfigProtocol {
    readonly configure = async (
        current: readonly SessionConfigOption[],
        change: SessionConfigChange,
        nativeSessionId: string,
        transport: SessionConfigTransport,
    ): Promise<readonly SessionConfigOption[]> => {
        const existing = current.find((option) => option.id === change.configId);
        if (
            existing === undefined ||
            (existing.id !== LEGACY_MODEL_CONFIG_ID && existing.id !== LEGACY_REASONING_EFFORT_CONFIG_ID)
        ) {
            return await standardSessionConfigProtocol.configure(current, change, nativeSessionId, transport);
        }
        const model = current.find((option) => option.category === "model");
        if (model === undefined) {
            return current;
        }
        if (existing.category === "thought_level" && change.value === AGENT_DEFAULT_REASONING_EFFORT) {
            return current;
        }
        const modelId = existing.category === "model" ? change.value : model.currentValue;
        const params: Record<string, unknown> = {
            modelId,
            sessionId: nativeSessionId,
        };
        if (existing.category === "thought_level") {
            params["_meta"] = {
                reasoningEffort: change.value,
            };
        }
        const response = await transport.request(
            "session/set_model",
            params,
            existing.category === "model"
                ? "Grok Build exited while setting the session model"
                : "Grok Build exited while setting reasoning effort",
            change.signal,
        );
        validateGrokResponse(response, modelId);
        const updated = updateCurrentValue(current, existing.category, change.value);
        return existing.category === "thought_level"
            ? updated.map((option) =>
                  option.category === "thought_level"
                      ? {
                            ...option,
                            values: option.values.filter((value) => value.value !== AGENT_DEFAULT_REASONING_EFFORT),
                        }
                      : option,
              )
            : updated;
    };

    readonly normalizeLifecycle = (response: unknown): readonly SessionConfigOption[] =>
        normalizeGrokLifecycle(response);

    readonly normalizeUpdate = (
        current: readonly SessionConfigOption[],
        value: unknown,
    ): readonly SessionConfigOption[] => standardSessionConfigProtocol.normalizeUpdate(current, value);
}

export const grokBuildSessionConfigProtocol = new GrokBuildSessionConfigProtocol();
