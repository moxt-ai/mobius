import type { SessionConfigOption } from "@moxt-ai/mobius-sdk";

const SESSION_CONFIG_PREFERENCE_PREFIX = "mobius:session-config-preferences:";
const LEGACY_SESSION_MODEL_PREFERENCE_PREFIX = "mobius:session-model-preferences:";
const SESSION_CONFIG_SELECTION_PREFIX = "mobius:session-config-selections:";
const MAXIMUM_PREFERENCES = 128;
const MAXIMUM_SELECTED_SESSIONS = 128;

export abstract class SessionConfigPreference {
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

function selectionStorageKey(channelId: string, agentId: string): string {
    return `${SESSION_CONFIG_SELECTION_PREFIX}${encodeURIComponent(channelId)}:${encodeURIComponent(agentId)}`;
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

function readStoredPreferencesValue(decoded: unknown): readonly SessionConfigPreference[] {
    if (!Array.isArray(decoded) || decoded.length > MAXIMUM_PREFERENCES) {
        return [];
    }
    const preferences = decoded.map(readPreference);
    const identifiers = new Set(preferences.map((preference) => preference.configId));
    return identifiers.size === preferences.length ? preferences : [];
}

function readStoredPreferences(key: string): readonly SessionConfigPreference[] {
    const encoded = window.localStorage.getItem(key);
    if (encoded === null) {
        return [];
    }
    return readStoredPreferencesValue(JSON.parse(encoded));
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
    const updated = options.map(preferenceFromOption);
    if (updated.length === 0) {
        return;
    }
    try {
        const identifiers = new Set(updated.map((preference) => preference.configId));
        const preserved = readSessionConfigPreferences(channelId, agentId).filter(
            (preference) => !identifiers.has(preference.configId),
        );
        const preferences = [...preserved, ...updated];
        if (preferences.length > MAXIMUM_PREFERENCES) {
            return;
        }
        window.localStorage.setItem(
            storageKey(SESSION_CONFIG_PREFERENCE_PREFIX, channelId, agentId),
            JSON.stringify(preferences),
        );
        window.localStorage.removeItem(storageKey(LEGACY_SESSION_MODEL_PREFERENCE_PREFIX, channelId, agentId));
    } catch {}
}

function storedSelections(value: unknown): ReadonlyMap<string, readonly SessionConfigPreference[]> {
    if (!isRecord(value)) {
        return new Map();
    }
    const selections = new Map<string, readonly SessionConfigPreference[]>();
    for (const [sessionId, options] of Object.entries(value).slice(0, MAXIMUM_SELECTED_SESSIONS)) {
        try {
            if (Array.isArray(options)) {
                selections.set(sessionId, readStoredPreferencesValue(options));
            }
        } catch {}
    }
    return selections;
}

function readOwnSessionConfigSelections(
    channelId: string,
    agentId: string,
    sessionId: string,
): readonly SessionConfigPreference[] {
    try {
        const encoded = window.localStorage.getItem(selectionStorageKey(channelId, agentId));
        return encoded === null ? [] : (storedSelections(JSON.parse(encoded)).get(sessionId) ?? []);
    } catch {
        return [];
    }
}

/**
 * The run settings one Session was last configured with.
 *
 * A Session owns its run settings, so reopening it has to show what that Session was configured with
 * rather than whatever the Agent was handed in some other conversation. An Agent-native Session keeps
 * its configuration only in this browser, so the selection is stored here, keyed by Session, and is
 * written by the change that produced it rather than by every prompt submitted afterwards.
 *
 * A Session that has not recorded one yet falls back to the Agent's, which is what a New chat inherits.
 * `ensureSessionConfigSelections` records that fallback when the Session opens, so it is only ever the
 * starting point of a Session rather than a value the Session keeps following.
 */
export function readSessionConfigSelections(
    channelId: string,
    agentId: string,
    sessionId: string,
): readonly SessionConfigPreference[] {
    const recorded = readOwnSessionConfigSelections(channelId, agentId, sessionId);
    return recorded.length > 0 ? recorded : readSessionConfigPreferences(channelId, agentId);
}

export function saveSessionConfigSelections(
    channelId: string,
    agentId: string,
    sessionId: string,
    options: readonly SessionConfigOption[],
): void {
    const updated = options.map(preferenceFromOption);
    if (updated.length === 0) {
        return;
    }
    try {
        const key = selectionStorageKey(channelId, agentId);
        const encoded = window.localStorage.getItem(key);
        const selections = new Map(storedSelections(encoded === null ? undefined : JSON.parse(encoded)));
        const identifiers = new Set(updated.map((preference) => preference.configId));
        const preserved = (selections.get(sessionId) ?? []).filter(
            (preference) => !identifiers.has(preference.configId),
        );
        selections.set(sessionId, [...preserved, ...updated]);
        window.localStorage.setItem(
            key,
            JSON.stringify(Object.fromEntries([...selections].slice(-MAXIMUM_SELECTED_SESSIONS))),
        );
    } catch {}
    // A change made in a conversation is also the user's newest choice for this Agent, which is what the
    // next New chat starts from. Reopening a Session without touching it does not come through here, so an
    // old conversation cannot silently become that choice again.
    saveSessionConfigPreferences(channelId, agentId, options);
}

/**
 * Gives a Session the run settings it opens with, without disturbing a Session that already has its own.
 *
 * A Session has to hold its settings from the moment it opens, not from the first change made in it.
 * Without that, every Session with no selection of its own would follow the Agent's newest one, so
 * choosing a model in one conversation would still restyle the composer of every other conversation on
 * that Agent -- including one the user opens only afterwards, which would begin on a setting they never
 * chose for it.
 */
export function ensureSessionConfigSelections(
    channelId: string,
    agentId: string,
    sessionId: string,
    options: readonly SessionConfigOption[],
): void {
    if (readOwnSessionConfigSelections(channelId, agentId, sessionId).length > 0) {
        return;
    }
    saveSessionConfigSelections(channelId, agentId, sessionId, options);
}
