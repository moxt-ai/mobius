import type { SessionConfigOption } from "@moxt-ai/mobius-web-sdk";
import { isModelConfigurationOption } from "@/services/session-config-presentation";

const SESSION_MODEL_PREFERENCE_PREFIX = "mobius:session-model-preferences:";
const MAXIMUM_PREFERENCES = 100;

abstract class SessionModelPreference {
  abstract readonly booleanValue: boolean;
  readonly configId: string;
  abstract readonly value: string;
  abstract readonly valueType: string;

  protected constructor(configId: string) {
    this.configId = configId;
  }
}

class BooleanSessionModelPreference extends SessionModelPreference {
  readonly booleanValue: boolean;
  readonly value = "";
  readonly valueType = "boolean";

  constructor(configId: string, booleanValue: boolean) {
    super(configId);
    this.booleanValue = booleanValue;
  }
}

class SelectSessionModelPreference extends SessionModelPreference {
  readonly booleanValue = false;
  readonly value: string;
  readonly valueType = "select";

  constructor(configId: string, value: string) {
    super(configId);
    this.value = value;
  }
}

function storageKey(channelId: string, agentId: string): string {
  return `${SESSION_MODEL_PREFERENCE_PREFIX}${encodeURIComponent(channelId)}:${encodeURIComponent(agentId)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPreference(value: unknown): SessionModelPreference {
  if (!isRecord(value)) {
    throw new Error("Saved model preference is not an object");
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
    throw new Error("Saved model preference is invalid");
  }
  if (valueType === "boolean") {
    if (typeof booleanValue !== "boolean") {
      throw new Error("Saved boolean model preference is invalid");
    }
    return new BooleanSessionModelPreference(configId, booleanValue);
  }
  if (typeof selectedValue !== "string" || selectedValue.length > 500) {
    throw new Error("Saved select model preference is invalid");
  }
  return new SelectSessionModelPreference(configId, selectedValue);
}

function preferenceFromOption(
  option: SessionConfigOption,
): SessionModelPreference {
  return option.type === "boolean"
    ? new BooleanSessionModelPreference(option.id, option.booleanValue)
    : new SelectSessionModelPreference(option.id, option.currentValue);
}

export function readSessionModelPreferences(
  channelId: string,
  agentId: string,
): readonly SessionModelPreference[] {
  try {
    const encoded = window.localStorage.getItem(storageKey(channelId, agentId));
    if (encoded === null) {
      return [];
    }
    const decoded: unknown = JSON.parse(encoded);
    if (!Array.isArray(decoded) || decoded.length > MAXIMUM_PREFERENCES) {
      return [];
    }
    const preferences = decoded.map(readPreference);
    const identifiers = new Set(
      preferences.map((preference) => preference.configId),
    );
    return identifiers.size === preferences.length ? preferences : [];
  } catch {
    return [];
  }
}

export function saveSessionModelPreferences(
  channelId: string,
  agentId: string,
  options: readonly SessionConfigOption[],
): void {
  const preferences = options
    .filter(isModelConfigurationOption)
    .map(preferenceFromOption);
  if (preferences.length === 0) {
    return;
  }
  try {
    window.localStorage.setItem(
      storageKey(channelId, agentId),
      JSON.stringify(preferences),
    );
  } catch {}
}
