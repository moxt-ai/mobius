import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";

const SESSION_CONFIG_PREFERENCE_PREFIX = "mobius:session-config-preferences:";
const LEGACY_SESSION_MODEL_PREFERENCE_PREFIX = "mobius:session-model-preferences:";
const MAXIMUM_PREFERENCES = 100;

abstract class SessionConfigPreference {
    abstract readonly booleanValue: boolean;
    readonly configId: string;
    abstract readonly value: string;
    abstract readonly valueType: string;

    protected constructor(configId: string) {
        this.configId = configId;
    }
}

class BooleanSessionConfigPreference extends SessionConfigPreference {
    readonly booleanValue: boolean;
    readonly value = "";
    readonly valueType = "boolean";

    constructor(configId: string, booleanValue: boolean) {
        super(configId);
        this.booleanValue = booleanValue;
    }
}

class SelectSessionConfigPreference extends SessionConfigPreference {
    readonly booleanValue = false;
    readonly value: string;
    readonly valueType = "select";

    constructor(configId: string, value: string) {
        super(configId);
        this.value = value;
    }
}

function storageKey(prefix: string, channelId: string, agentId: string): string {
    return `${prefix}${encodeURIComponent(channelId)}:${encodeURIComponent(agentId)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPreference(value: unknown): SessionConfigPreference {
    if (!isRecord(value)) {
        throw new Error("Saved configuration preference is not an object");
    }
    const booleanValue = value["booleanValue"];
    const configId = value["configId"];
    const selectedValue = value["value"];
    const valueType = value["valueType"];
    if (
        typeof configId !== "string" ||
        configId.length === 0 ||
        configId.length > 128 ||
        typeof valueType !== "string" ||
        (valueType !== "boolean" && valueType !== "select")
    ) {
        throw new Error("Saved configuration preference is invalid");
    }
    if (valueType === "boolean") {
        if (typeof booleanValue !== "boolean") {
            throw new Error("Saved boolean configuration preference is invalid");
        }
        return new BooleanSessionConfigPreference(configId, booleanValue);
    }
    if (typeof selectedValue !== "string" || selectedValue.length > 500) {
        throw new Error("Saved select configuration preference is invalid");
    }
    return new SelectSessionConfigPreference(configId, selectedValue);
}

function preferenceFromOption(option: SessionConfigOption): SessionConfigPreference {
    return option.type === "boolean"
        ? new BooleanSessionConfigPreference(option.id, option.booleanValue)
        : new SelectSessionConfigPreference(option.id, option.currentValue);
}

function readStoredPreferences(key: string): readonly SessionConfigPreference[] {
    const encoded = window.localStorage.getItem(key);
    if (encoded === null) {
        return [];
    }
    const decoded: unknown = JSON.parse(encoded);
    if (!Array.isArray(decoded) || decoded.length > MAXIMUM_PREFERENCES) {
        return [];
    }
    const preferences = decoded.map(readPreference);
    const identifiers = new Set(preferences.map((preference) => preference.configId));
    return identifiers.size === preferences.length ? preferences : [];
}

export function readSessionConfigPreferences(channelId: string, agentId: string): readonly SessionConfigPreference[] {
    try {
        const preferences = readStoredPreferences(storageKey(SESSION_CONFIG_PREFERENCE_PREFIX, channelId, agentId));
        if (preferences.length > 0) {
            return preferences;
        }
        return readStoredPreferences(storageKey(LEGACY_SESSION_MODEL_PREFERENCE_PREFIX, channelId, agentId));
    } catch {
        return [];
    }
}

export function saveSessionConfigPreferences(
    channelId: string,
    agentId: string,
    options: readonly SessionConfigOption[],
): void {
    const preferences = options.map(preferenceFromOption);
    if (preferences.length === 0) {
        return;
    }
    try {
        window.localStorage.setItem(
            storageKey(SESSION_CONFIG_PREFERENCE_PREFIX, channelId, agentId),
            JSON.stringify(preferences),
        );
        window.localStorage.removeItem(storageKey(LEGACY_SESSION_MODEL_PREFERENCE_PREFIX, channelId, agentId));
    } catch {}
}
