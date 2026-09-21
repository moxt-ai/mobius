import type {
    AgentModelEffort,
    AgentSetting,
    AgentSettingsDiscoveredEvent,
    SessionConfigOption,
    SessionConfigurationSelection,
} from "@moxt-ai/mobius-sdk";
import { readStoredAgentSettings, saveStoredAgentSettings } from "@/services/agent-settings-storage";
import { readSessionConfigPreferences, saveSessionConfigPreferences } from "@/services/session-config-preferences";

const MODEL_EFFORT_COMPLETE = "complete";
const MODEL_EFFORT_ON_MODEL_SELECTION = "on_model_selection";

export interface AgentSettingsDiscovery {
    readonly discover: (agentId: string, model: string, signal: AbortSignal) => Promise<AgentSettingsDiscoveredEvent>;
}

export interface AgentVersions {
    readonly version: (agentId: string) => string;
}

export class CachedAgentSettings {
    readonly agentId: string;
    readonly event: AgentSettingsDiscoveredEvent;
    readonly options: readonly SessionConfigOption[];

    constructor(agentId: string, event: AgentSettingsDiscoveredEvent, options: readonly SessionConfigOption[]) {
        this.agentId = agentId;
        this.event = event;
        this.options = Object.freeze([...options]);
    }

    readonly selections = (): readonly SessionConfigurationSelection[] =>
        this.options.map((option) => ({
            booleanValue: option.type === "boolean" ? option.booleanValue : false,
            configId: option.id,
            value: option.type === "select" ? option.currentValue : "",
            valueType: option.type,
        }));
}

class PendingAgentSettings {
    readonly controller: AbortController;
    readonly completion: Promise<CachedAgentSettings>;

    constructor(controller: AbortController, completion: Promise<CachedAgentSettings>) {
        this.controller = controller;
        this.completion = completion;
    }
}

function selectedStringValue(setting: AgentSetting): string {
    if (setting.values.some((candidate) => candidate.value === setting.defaultValue)) {
        return setting.defaultValue;
    }
    return setting.values[0]?.value ?? "";
}

function optionFromSetting(
    setting: AgentSetting,
    preferences: ReturnType<typeof readSessionConfigPreferences>,
): SessionConfigOption {
    const preference = preferences.find((candidate) => candidate.configId === setting.id);
    if (
        setting.type === "select" &&
        preference !== undefined &&
        preference.valueType === "select" &&
        setting.values.some((candidate) => candidate.value === preference.value)
    ) {
        return {
            booleanValue: false,
            category: setting.category,
            currentValue: preference.value,
            description: setting.description,
            id: setting.id,
            name: setting.name,
            type: setting.type,
            values: setting.values,
        };
    }
    if (setting.type === "boolean" && preference !== undefined && preference.valueType === "boolean") {
        return {
            booleanValue: preference.booleanValue,
            category: setting.category,
            currentValue: "",
            description: setting.description,
            id: setting.id,
            name: setting.name,
            type: setting.type,
            values: setting.values,
        };
    }
    return {
        booleanValue: setting.type === "boolean" ? setting.booleanValue : false,
        category: setting.category,
        currentValue: setting.type === "select" ? selectedStringValue(setting) : "",
        description: setting.description,
        id: setting.id,
        name: setting.name,
        type: setting.type,
        values: setting.values,
    };
}

function selectedOption(options: readonly SessionConfigOption[], id: string): SessionConfigOption | undefined {
    return options.find((option) => option.id === id);
}

function selectedModel(options: readonly SessionConfigOption[], modelEffort: AgentModelEffort): string {
    const model = selectedOption(options, modelEffort.modelSettingId);
    return model?.type === "select" ? model.currentValue : "";
}

function defaultEffortValue(
    event: AgentSettingsDiscoveredEvent,
    effortId: string,
    values: SessionConfigOption["values"],
): string {
    const defaultValue = event.settings.find((setting) => setting.id === effortId)?.defaultValue ?? "";
    if (values.some((candidate) => candidate.value === defaultValue)) {
        return defaultValue;
    }
    return values[0]?.value ?? "";
}

function inferredDefaultModelEffortValues(
    event: AgentSettingsDiscoveredEvent,
): Readonly<Record<string, AgentSetting["values"]>> {
    const model = event.settings.find((setting) => setting.id === event.modelEffort.modelSettingId);
    const effort = event.settings.find((setting) => setting.id === event.modelEffort.effortSettingId);
    if (
        model === undefined ||
        model.type !== "select" ||
        model.defaultValue.length === 0 ||
        effort === undefined ||
        effort.type !== "select"
    ) {
        return {};
    }
    return { [model.defaultValue]: effort.values };
}

function eventWithCachedModelEffortValues(
    event: AgentSettingsDiscoveredEvent,
    cached: CachedAgentSettings | undefined,
): AgentSettingsDiscoveredEvent {
    if (event.modelEffort.resolution !== MODEL_EFFORT_ON_MODEL_SELECTION) {
        return event;
    }
    // A named-model lookup contributes one model's effort to the Agent's otherwise
    // stable capability document, and the base lookup reports only the Agent's own
    // default. Both have to accumulate onto what this browser already resolved, or a
    // base rediscovery would silently drop the effort values of every other model the
    // user selected and force a second lookup for the selection that is still current.
    const canReuseCachedCapability =
        cached !== undefined &&
        cached.event.settingsRevision === event.settingsRevision &&
        cached.event.modelEffort.resolution === MODEL_EFFORT_ON_MODEL_SELECTION;
    const unsupportedModels = new Set(event.modelEffort.unsupportedModelIds);
    const previousValues = Object.fromEntries(
        Object.entries(
            canReuseCachedCapability && cached !== undefined ? cached.event.modelEffort.valuesByModel : {},
        ).filter(([model]) => !unsupportedModels.has(model)),
    );
    const effortSettingId =
        event.modelEffort.effortSettingId.length > 0
            ? event.modelEffort.effortSettingId
            : canReuseCachedCapability && cached !== undefined
              ? cached.event.modelEffort.effortSettingId
              : "";
    let settings = event.settings;
    if (
        canReuseCachedCapability &&
        cached !== undefined &&
        effortSettingId.length > 0 &&
        !settings.some((setting) => setting.id === effortSettingId)
    ) {
        const cachedEffort = cached.event.settings.find((setting) => setting.id === effortSettingId);
        if (cachedEffort !== undefined) {
            settings = [...settings, cachedEffort];
        }
    }
    return {
        ...event,
        settings,
        modelEffort: {
            ...event.modelEffort,
            effortSettingId,
            valuesByModel: {
                ...previousValues,
                ...inferredDefaultModelEffortValues(event),
                ...event.modelEffort.valuesByModel,
            },
        },
    };
}

function withResolvedEffortOptions(
    event: AgentSettingsDiscoveredEvent,
    options: readonly SessionConfigOption[],
): readonly SessionConfigOption[] {
    if (
        event.modelEffort.resolution !== MODEL_EFFORT_COMPLETE &&
        event.modelEffort.resolution !== MODEL_EFFORT_ON_MODEL_SELECTION
    ) {
        return options;
    }
    const modelValue = selectedModel(options, event.modelEffort);
    const values = event.modelEffort.valuesByModel[modelValue];
    if (values === undefined) {
        return options;
    }
    if (values.length === 0) {
        return options.filter((option) => option.id !== event.modelEffort.effortSettingId);
    }
    return options.map((option) => {
        if (option.id !== event.modelEffort.effortSettingId || option.type !== "select") {
            return option;
        }
        const currentValue = values.some((candidate) => candidate.value === option.currentValue)
            ? option.currentValue
            : defaultEffortValue(event, option.id, values);
        return {
            ...option,
            currentValue,
            values,
        };
    });
}

function optionsWithCachedEffortSetting(
    event: AgentSettingsDiscoveredEvent,
    options: readonly SessionConfigOption[],
    preferences: ReturnType<typeof readSessionConfigPreferences>,
): readonly SessionConfigOption[] {
    const effortSettingId = event.modelEffort.effortSettingId;
    if (effortSettingId.length === 0 || options.some((option) => option.id === effortSettingId)) {
        return options;
    }
    const effort = event.settings.find((setting) => setting.id === effortSettingId);
    return effort === undefined ? options : [...options, optionFromSetting(effort, preferences)];
}

function optionWithSelection(
    options: readonly SessionConfigOption[],
    configId: string,
    value: string,
    booleanValue: boolean,
): readonly SessionConfigOption[] {
    let found = false;
    const selected = options.map((option) => {
        if (option.id !== configId) {
            return option;
        }
        found = true;
        if (option.type === "boolean") {
            return { ...option, booleanValue };
        }
        if (!option.values.some((candidate) => candidate.value === value)) {
            throw new Error("The selected Agent setting is unavailable");
        }
        return { ...option, currentValue: value };
    });
    if (!found) {
        throw new Error("The selected Agent setting is unavailable");
    }
    return selected;
}

function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = (): void => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        void operation.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener("abort", abort);
                reject(error);
            },
        );
    });
}

export class AgentSettingsCache {
    readonly #channelId: string;
    readonly #discovery: AgentSettingsDiscovery;
    readonly #entries = new Map<string, CachedAgentSettings>();
    readonly #pending = new Map<string, PendingAgentSettings>();
    readonly #versions: AgentVersions;

    constructor(channelId: string, discovery: AgentSettingsDiscovery, versions: AgentVersions) {
        this.#channelId = channelId;
        this.#discovery = discovery;
        this.#versions = versions;
    }

    readonly close = (): void => {
        for (const pending of this.#pending.values()) {
            pending.controller.abort(new Error("The Agent settings cache closed"));
        }
        this.#pending.clear();
        this.#entries.clear();
    };

    readonly load = async (agentId: string, force: boolean, signal: AbortSignal): Promise<CachedAgentSettings> => {
        const existing = this.#entries.get(agentId) ?? this.#restored(agentId);
        const initial = force || existing === undefined ? await this.#discover(agentId, "", signal) : existing;
        return await this.#resolveSelectedModel(initial, signal);
    };

    readonly select = async (
        agentId: string,
        configId: string,
        value: string,
        booleanValue: boolean,
        signal: AbortSignal,
    ): Promise<CachedAgentSettings> => {
        const existing = await this.load(agentId, false, signal);
        const preferences = readSessionConfigPreferences(this.#channelId, agentId);
        const selected = optionWithSelection(
            optionsWithCachedEffortSetting(existing.event, existing.options, preferences),
            configId,
            value,
            booleanValue,
        );
        const modelChanged = configId === existing.event.modelEffort.modelSettingId;
        const needsSelectedModelDiscovery =
            modelChanged &&
            existing.event.modelEffort.resolution === MODEL_EFFORT_ON_MODEL_SELECTION &&
            existing.event.modelEffort.valuesByModel[value] === undefined;
        const next = needsSelectedModelDiscovery
            ? await this.#selectedModelEntry(agentId, value, signal)
            : new CachedAgentSettings(agentId, existing.event, withResolvedEffortOptions(existing.event, selected));
        const selectedEntry = needsSelectedModelDiscovery
            ? new CachedAgentSettings(
                  agentId,
                  next.event,
                  optionWithSelection(
                      optionsWithCachedEffortSetting(next.event, next.options, preferences),
                      configId,
                      value,
                      booleanValue,
                  ),
              )
            : next;
        const adjusted = new CachedAgentSettings(
            agentId,
            selectedEntry.event,
            withResolvedEffortOptions(
                selectedEntry.event,
                optionsWithCachedEffortSetting(selectedEntry.event, selectedEntry.options, preferences),
            ),
        );
        this.#entries.set(agentId, adjusted);
        saveSessionConfigPreferences(this.#channelId, agentId, adjusted.options);
        return adjusted;
    };

    readonly #discover = async (agentId: string, model: string, signal: AbortSignal): Promise<CachedAgentSettings> => {
        const key = `${agentId}\u0000${model}`;
        const pending = this.#pending.get(key);
        if (pending !== undefined) {
            return await waitFor(pending.completion, signal);
        }
        const controller = new AbortController();
        const operationSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
        const completion = this.#discovery
            .discover(agentId, model, operationSignal)
            .then((event) => this.#entryFromEvent(agentId, event))
            .then((entry) => {
                this.#entries.set(agentId, entry);
                return entry;
            })
            .finally(() => {
                this.#pending.delete(key);
            });
        const active = new PendingAgentSettings(controller, completion);
        this.#pending.set(key, active);
        return await waitFor(completion, signal);
    };

    readonly #entryFromEvent = (agentId: string, event: AgentSettingsDiscoveredEvent): CachedAgentSettings => {
        const cachedEvent = eventWithCachedModelEffortValues(
            event,
            this.#entries.get(agentId) ?? this.#restored(agentId),
        );
        const preferences = readSessionConfigPreferences(this.#channelId, agentId);
        const options = withResolvedEffortOptions(
            cachedEvent,
            cachedEvent.settings.map((setting) => optionFromSetting(setting, preferences)),
        );
        saveStoredAgentSettings(this.#channelId, agentId, this.#versions.version(agentId), cachedEvent);
        return new CachedAgentSettings(agentId, cachedEvent, options);
    };

    readonly #restored = (agentId: string): CachedAgentSettings | undefined => {
        const event = readStoredAgentSettings(this.#channelId, agentId, this.#versions.version(agentId));
        if (event === undefined) {
            return undefined;
        }
        const preferences = readSessionConfigPreferences(this.#channelId, agentId);
        const entry = new CachedAgentSettings(
            agentId,
            event,
            withResolvedEffortOptions(
                event,
                event.settings.map((setting) => optionFromSetting(setting, preferences)),
            ),
        );
        this.#entries.set(agentId, entry);
        return entry;
    };

    readonly #resolveSelectedModel = async (
        entry: CachedAgentSettings,
        signal: AbortSignal,
    ): Promise<CachedAgentSettings> => {
        if (entry.event.modelEffort.resolution !== MODEL_EFFORT_ON_MODEL_SELECTION) {
            return entry;
        }
        const model = selectedModel(entry.options, entry.event.modelEffort);
        const defaultModel = entry.event.settings.find(
            (setting) => setting.id === entry.event.modelEffort.modelSettingId,
        )?.defaultValue;
        if (
            model.length === 0 ||
            entry.event.modelEffort.valuesByModel[model] !== undefined ||
            model === defaultModel
        ) {
            return entry;
        }
        return await this.#selectedModelEntry(entry.agentId, model, signal);
    };

    readonly #selectedModelEntry = async (
        agentId: string,
        model: string,
        signal: AbortSignal,
    ): Promise<CachedAgentSettings> => await this.#discover(agentId, model, signal);
}
