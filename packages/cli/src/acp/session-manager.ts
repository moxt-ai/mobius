import { spawn } from "node:child_process";

import {
  type AgentCapabilities,
  type ClientConnection,
  type CompleteElicitationNotification,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationContentValue,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AGENT_CONTENT_KIND,
  type AgentContentEvent,
  type AgentPromptResponse,
  decodeAgentPromptResponse,
  type NativeSessionHistory,
  type PromptImage,
  type PromptResource,
  SESSION_COMMANDS_UPDATED_KIND,
  SESSION_CONFIG_UPDATED_KIND,
  SESSION_ELICITATION_REQUESTED_KIND,
  SESSION_ELICITATION_RESOLVED_KIND,
  SESSION_INFO_UPDATED_KIND,
  SESSION_PERMISSION_REQUESTED_KIND,
  SESSION_PERMISSION_RESOLVED_KIND,
  SESSION_USAGE_UPDATED_KIND,
  type SessionCapabilities,
  type SessionCommand,
  type SessionCommandsUpdatedEvent,
  type SessionConfigOption,
  type SessionConfigUpdatedEvent,
  type SessionConfigValue,
  type SessionElicitationField,
  type SessionElicitationOption,
  type SessionElicitationRequestedEvent,
  type SessionElicitationResolvedEvent,
  type SessionInfoUpdatedEvent,
  type SessionPermissionOption,
  type SessionPermissionRequestedEvent,
  type SessionPermissionResolvedEvent,
  type SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";

import type { LocalAgentDefinition } from "../config.ts";
import {
  revalidateExecutable,
  stopProcessTree,
} from "../process/executable.ts";
import {
  type AcpActivity,
  AcpActivityTracker,
  isProgressMessage,
  normalizeContentBlock,
} from "./activity.ts";
import { type AcpClientHandler, createAcpClient } from "./create-client.ts";
import {
  type NativeSessionOrigin,
  type NativeSessionPage,
  nativeSessionIdSchema,
  nativeSessionPageSchema,
} from "./native-session.ts";
import { AcpHistoryReplay } from "./session-history.ts";
import {
  type AcpSessionStore,
  AcpStoredSession,
  DeletedAcpStoredSession,
  FoundAcpStoredSession,
  MemoryAcpSessionStore,
} from "./session-store.ts";

const PROCESS_STOP_TIMEOUT_MILLISECONDS = 1_000;
const SESSION_CONTROL_COMMAND_ID = "session-control";

export interface AcpPrepareOptions {
  readonly additionalDirectories: readonly string[];
  readonly agent: LocalAgentDefinition;
  readonly cwd: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly origin?: NativeSessionOrigin;
}

export interface AcpConfigureOptions extends AcpPrepareOptions {
  readonly booleanValue: boolean;
  readonly configId: string;
  readonly requestId: string;
  readonly value: string;
  readonly valueType: SessionConfigOption["type"];
}

export interface AcpTurnOptions extends AcpPrepareOptions {
  readonly commandId: string;
  readonly images: readonly PromptImage[];
  readonly onActivity: (activity: AcpActivity) => Promise<void>;
  readonly onText: (text: string) => Promise<void>;
  readonly prompt: string;
  readonly resources: readonly PromptResource[];
}

export interface AcpPermissionResponseOptions {
  readonly interactionId: string;
  readonly optionId: string;
  readonly outcome: SessionPermissionResolvedEvent["outcome"];
  readonly sessionId: string;
}

export interface AcpElicitationResponseOptions {
  readonly action: SessionElicitationResolvedEvent["action"];
  readonly content: string;
  readonly interactionId: string;
  readonly sessionId: string;
}

export type AcpPromptResult = AgentPromptResponse;

export interface AcpSessionObserver {
  readonly onCommands: (event: SessionCommandsUpdatedEvent) => Promise<void>;
  readonly onConfig: (event: SessionConfigUpdatedEvent) => Promise<void>;
  readonly onContent: (event: AgentContentEvent) => Promise<void>;
  readonly onElicitation: (
    event: SessionElicitationRequestedEvent,
  ) => Promise<void>;
  readonly onElicitationResolved: (
    event: SessionElicitationResolvedEvent,
  ) => Promise<void>;
  readonly onInfo: (event: SessionInfoUpdatedEvent) => Promise<void>;
  readonly onPermission: (
    event: SessionPermissionRequestedEvent,
  ) => Promise<void>;
  readonly onPermissionResolved: (
    event: SessionPermissionResolvedEvent,
  ) => Promise<void>;
  readonly onUsage: (event: SessionUsageUpdatedEvent) => Promise<void>;
}

export class NullAcpSessionObserver implements AcpSessionObserver {
  readonly onCommands = (): Promise<void> => Promise.resolve();
  readonly onConfig = (): Promise<void> => Promise.resolve();
  readonly onContent = (): Promise<void> => Promise.resolve();
  readonly onElicitation = (): Promise<void> => Promise.resolve();
  readonly onElicitationResolved = (): Promise<void> => Promise.resolve();
  readonly onInfo = (): Promise<void> => Promise.resolve();
  readonly onPermission = (): Promise<void> => Promise.resolve();
  readonly onPermissionResolved = (): Promise<void> => Promise.resolve();
  readonly onUsage = (): Promise<void> => Promise.resolve();
}

export class AcpPreparedSession {
  readonly agentName: string;
  readonly agentVersion: string;
  readonly capabilities: SessionCapabilities;
  readonly commands: readonly SessionCommand[];
  readonly configOptions: readonly SessionConfigOption[];
  readonly restored: boolean;

  constructor(
    agentName: string,
    agentVersion: string,
    capabilities: SessionCapabilities,
    commands: readonly SessionCommand[],
    configOptions: readonly SessionConfigOption[],
    restored: boolean,
  ) {
    this.agentName = agentName;
    this.agentVersion = agentVersion;
    this.capabilities = capabilities;
    this.commands = commands;
    this.configOptions = configOptions;
    this.restored = restored;
  }
}

export class AcpExecutionError extends Error {
  readonly code: string;

  constructor(
    message: string,
    options: ErrorOptions = {},
    code = "acp_execution_failed",
  ) {
    super(message, options);
    this.code = code;
    this.name = "AcpExecutionError";
  }
}

class RetryableAcpInitializationError extends AcpExecutionError {
  constructor(cause: unknown) {
    super("ACP agent initialization failed", { cause });
    this.name = "RetryableAcpInitializationError";
  }
}

function readableWebStream(
  input: NodeJS.ReadableStream,
): ReadableStream<Uint8Array> {
  let streamOpen = true;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: unknown) => {
        if (!streamOpen) {
          return;
        }
        if (chunk instanceof Uint8Array) {
          controller.enqueue(new Uint8Array(chunk));
          return;
        }
        streamOpen = false;
        controller.error(new Error("ACP process produced a non-binary chunk"));
      });
      input.once("end", () => {
        if (!streamOpen) {
          return;
        }
        streamOpen = false;
        controller.close();
      });
      input.once("error", (error) => {
        if (!streamOpen) {
          return;
        }
        streamOpen = false;
        controller.error(error);
      });
    },
    cancel() {
      streamOpen = false;
    },
  });
}

export function createWritableAcpStream(
  output: NodeJS.WritableStream,
): WritableStream<Uint8Array> {
  let outputFailure: unknown;
  const pendingWriteFailures = new Set<(error: unknown) => void>();
  const fail = (error: unknown): void => {
    outputFailure = error;
    for (const reject of pendingWriteFailures) {
      reject(error);
    }
    pendingWriteFailures.clear();
  };
  output.on("error", fail);
  output.once("close", () => {
    if (outputFailure === undefined) {
      fail(new Error("ACP process input closed"));
    }
  });
  return new WritableStream<Uint8Array>({
    write(chunk) {
      if (outputFailure !== undefined) {
        return Promise.reject(outputFailure);
      }
      return new Promise<void>((resolve, reject) => {
        pendingWriteFailures.add(reject);
        output.write(chunk, (error) => {
          pendingWriteFailures.delete(reject);
          if (error) {
            outputFailure = error;
            reject(error);
            return;
          }
          if (outputFailure !== undefined) {
            reject(outputFailure);
            return;
          }
          resolve();
        });
      });
    },
  });
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function normalizeConfigValue(
  option: Readonly<Record<string, unknown>>,
  groupId = "",
  groupName = "",
): SessionConfigValue {
  return {
    description: truncate(readString(option["description"]), 500),
    groupId: truncate(groupId, 128),
    groupName: truncate(groupName, 255),
    name: truncate(
      readString(option["name"], readString(option["value"])),
      255,
    ),
    value: truncate(readString(option["value"]), 500),
  };
}

function normalizeConfigValues(value: unknown): readonly SessionConfigValue[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: SessionConfigValue[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const groupedOptions = entry["options"];
    if (Array.isArray(groupedOptions)) {
      const groupId = readString(entry["group"]);
      const groupName = readString(entry["name"]);
      for (const groupedOption of groupedOptions) {
        if (isRecord(groupedOption)) {
          normalized.push(
            normalizeConfigValue(groupedOption, groupId, groupName),
          );
        }
      }
      continue;
    }
    normalized.push(normalizeConfigValue(entry));
  }
  return normalized.filter((entry) => entry.value.length > 0).slice(0, 500);
}

function normalizeConfigOptions(
  value: unknown,
  modes: unknown,
): readonly SessionConfigOption[] {
  const normalized: SessionConfigOption[] = [];
  if (Array.isArray(value)) {
    for (const option of value) {
      if (!isRecord(option)) {
        continue;
      }
      const id = truncate(readString(option["id"]), 128);
      const name = truncate(readString(option["name"], id), 255);
      if (id.length === 0 || name.length === 0) {
        continue;
      }
      if (option["type"] === "boolean") {
        normalized.push({
          booleanValue: readBoolean(option["currentValue"]),
          category: truncate(readString(option["category"]), 128),
          currentValue: "",
          description: truncate(readString(option["description"]), 500),
          id,
          name,
          type: "boolean",
          values: [],
        });
        continue;
      }
      if (option["type"] === "select") {
        const values = normalizeConfigValues(option["options"]);
        const currentValue = truncate(readString(option["currentValue"]), 500);
        if (
          currentValue.length > 0 &&
          values.some((entry) => entry.value === currentValue)
        ) {
          normalized.push({
            booleanValue: false,
            category: truncate(readString(option["category"]), 128),
            currentValue,
            description: truncate(readString(option["description"]), 500),
            id,
            name,
            type: "select",
            values,
          });
        }
      }
    }
  }
  if (isRecord(modes)) {
    const values: SessionConfigValue[] = [];
    const availableModes = modes["availableModes"];
    if (Array.isArray(availableModes)) {
      for (const mode of availableModes) {
        if (!isRecord(mode)) {
          continue;
        }
        const id = truncate(readString(mode["id"]), 500);
        if (id.length === 0) {
          continue;
        }
        values.push({
          description: truncate(readString(mode["description"]), 500),
          groupId: "",
          groupName: "",
          name: truncate(readString(mode["name"], id), 255),
          value: id,
        });
      }
    }
    const currentValue = truncate(readString(modes["currentModeId"]), 500);
    if (
      currentValue.length > 0 &&
      values.some((entry) => entry.value === currentValue) &&
      !normalized.some((entry) => entry.category === "mode")
    ) {
      normalized.unshift({
        booleanValue: false,
        category: "mode",
        currentValue,
        description: "Agent session mode",
        id: "mode",
        name: "Mode",
        type: "select",
        values,
      });
    }
  }
  return normalized.slice(0, 100);
}

function replaceConfigOptionsKeepingMode(
  current: readonly SessionConfigOption[],
  value: unknown,
): readonly SessionConfigOption[] {
  const next = normalizeConfigOptions(value, undefined);
  if (next.some((option) => option.category === "mode")) {
    return next;
  }
  return [
    ...current.filter((option) => option.category === "mode"),
    ...next,
  ].slice(0, 100);
}

function normalizeCapabilities(
  capabilities: AgentCapabilities,
): SessionCapabilities {
  const session = capabilities.sessionCapabilities;
  const prompt = capabilities.promptCapabilities;
  return {
    additionalDirectories: session?.additionalDirectories != null,
    audioPrompt: prompt?.audio === true,
    closeSession: session?.close != null,
    deleteSession: session?.delete != null,
    embeddedContextPrompt: prompt?.embeddedContext === true,
    imagePrompt: prompt?.image === true,
    listSessions: session?.list != null,
    loadSession: capabilities.loadSession === true,
    resumeSession: session?.resume != null,
    unstableForkSession: session?.fork != null,
  };
}

function elicitationFieldType(value: unknown): SessionElicitationField["type"] {
  if (value === "boolean") {
    return "boolean";
  }
  if (value === "integer") {
    return "integer";
  }
  if (value === "number") {
    return "number";
  }
  if (value === "array") {
    return "multiselect";
  }
  return "string";
}

function normalizeElicitationOptions(
  schema: Readonly<Record<string, unknown>>,
): readonly SessionElicitationOption[] {
  const normalized: SessionElicitationOption[] = [];
  const oneOf = schema["oneOf"];
  if (Array.isArray(oneOf)) {
    for (const option of oneOf) {
      if (isRecord(option) && typeof option["const"] === "string") {
        normalized.push({
          description: truncate(readString(option["description"]), 500),
          label: truncate(readString(option["title"], option["const"]), 255),
          value: truncate(option["const"], 500),
        });
      }
    }
    return normalized.slice(0, 200);
  }
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) {
    for (const entry of enumValues) {
      if (typeof entry === "string") {
        normalized.push({ description: "", label: entry, value: entry });
      }
    }
    return normalized.slice(0, 200);
  }
  const items = schema["items"];
  if (!isRecord(items)) {
    return normalized;
  }
  const anyOf = items["anyOf"];
  if (Array.isArray(anyOf)) {
    return normalizeElicitationOptions({ oneOf: anyOf });
  }
  return normalizeElicitationOptions({ enum: items["enum"] });
}

function numericString(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toString()
    : "";
}

function normalizeElicitationFields(
  requestedSchema: unknown,
): readonly SessionElicitationField[] {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema["properties"])) {
    return [];
  }
  const properties = requestedSchema["properties"];
  const requiredValues = requestedSchema["required"];
  const required = new Set<string>(
    Array.isArray(requiredValues)
      ? requiredValues.filter((entry) => typeof entry === "string")
      : [],
  );
  const normalized: SessionElicitationField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!isRecord(property)) {
      continue;
    }
    const type = elicitationFieldType(property["type"]);
    const options = normalizeElicitationOptions(property);
    const normalizedType =
      type === "string" && options.length > 0 ? "select" : type;
    const defaultValue = property["default"];
    normalized.push({
      defaultBooleanValue:
        typeof defaultValue === "boolean" ? defaultValue : false,
      defaultNumberValue:
        typeof defaultValue === "number" && Number.isFinite(defaultValue)
          ? defaultValue
          : 0,
      defaultStringValue:
        typeof defaultValue === "string"
          ? truncate(defaultValue, 10_000)
          : Array.isArray(defaultValue)
            ? truncate(JSON.stringify(defaultValue), 10_000)
            : "",
      description: truncate(readString(property["description"]), 500),
      format: truncate(readString(property["format"]), 64),
      hasDefaultValue: defaultValue !== undefined && defaultValue !== null,
      maximum: numericString(property["maximum"]),
      maximumLength: numericString(
        property["maxLength"] ?? property["maxItems"],
      ),
      minimum: numericString(property["minimum"]),
      minimumLength: numericString(
        property["minLength"] ?? property["minItems"],
      ),
      name: truncate(name, 128),
      options,
      pattern: truncate(readString(property["pattern"]), 500),
      required: required.has(name),
      title: truncate(readString(property["title"], name), 255),
      type: normalizedType,
    });
  }
  return normalized.slice(0, 100);
}

function validateStringValue(
  name: string,
  value: string,
  schema: Readonly<Record<string, unknown>>,
): void {
  const minimum = schema["minLength"];
  const maximum = schema["maxLength"];
  if (typeof minimum === "number" && value.length < minimum) {
    throw new AcpExecutionError(
      `Elicitation field ${name} is shorter than allowed`,
      {},
      "invalid_elicitation_response",
    );
  }
  if (typeof maximum === "number" && value.length > maximum) {
    throw new AcpExecutionError(
      `Elicitation field ${name} is longer than allowed`,
      {},
      "invalid_elicitation_response",
    );
  }
  const pattern = schema["pattern"];
  if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
    throw new AcpExecutionError(
      `Elicitation field ${name} does not match the required format`,
      {},
      "invalid_elicitation_response",
    );
  }
  const allowed = normalizeElicitationOptions(schema);
  if (allowed.length > 0 && !allowed.some((entry) => entry.value === value)) {
    throw new AcpExecutionError(
      `Elicitation field ${name} is not an allowed value`,
      {},
      "invalid_elicitation_response",
    );
  }
}

function validateNumericValue(
  name: string,
  value: number,
  schema: Readonly<Record<string, unknown>>,
  integer: boolean,
): void {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new AcpExecutionError(
      `Elicitation field ${name} is not a valid number`,
      {},
      "invalid_elicitation_response",
    );
  }
  const minimum = schema["minimum"];
  const maximum = schema["maximum"];
  if (
    (typeof minimum === "number" && value < minimum) ||
    (typeof maximum === "number" && value > maximum)
  ) {
    throw new AcpExecutionError(
      `Elicitation field ${name} is outside the allowed range`,
      {},
      "invalid_elicitation_response",
    );
  }
}

function validateElicitationContent(
  encoded: string,
  requestedSchema: unknown,
): Readonly<Record<string, ElicitationContentValue>> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch (error) {
    throw new AcpExecutionError(
      "Elicitation response is not valid JSON",
      { cause: error },
      "invalid_elicitation_response",
    );
  }
  if (
    !isRecord(decoded) ||
    !isRecord(requestedSchema) ||
    !isRecord(requestedSchema["properties"])
  ) {
    throw new AcpExecutionError(
      "Elicitation response does not match the requested form",
      {},
      "invalid_elicitation_response",
    );
  }
  const properties = requestedSchema["properties"];
  const requiredValue = requestedSchema["required"];
  const required = new Set<string>(
    Array.isArray(requiredValue)
      ? requiredValue.filter((entry) => typeof entry === "string")
      : [],
  );
  for (const name of required) {
    if (!(name in decoded)) {
      throw new AcpExecutionError(
        `Elicitation field ${name} is required`,
        {},
        "invalid_elicitation_response",
      );
    }
  }
  const validated: Record<string, ElicitationContentValue> = {};
  for (const [name, value] of Object.entries(decoded)) {
    const property = properties[name];
    if (!isRecord(property)) {
      throw new AcpExecutionError(
        `Elicitation field ${name} was not requested`,
        {},
        "invalid_elicitation_response",
      );
    }
    if (property["type"] === "string" && typeof value === "string") {
      validateStringValue(name, value, property);
      validated[name] = value;
      continue;
    }
    if (property["type"] === "number" && typeof value === "number") {
      validateNumericValue(name, value, property, false);
      validated[name] = value;
      continue;
    }
    if (property["type"] === "integer" && typeof value === "number") {
      validateNumericValue(name, value, property, true);
      validated[name] = value;
      continue;
    }
    if (property["type"] === "boolean" && typeof value === "boolean") {
      validated[name] = value;
      continue;
    }
    if (
      property["type"] === "array" &&
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      const minimum = property["minItems"];
      const maximum = property["maxItems"];
      if (
        (typeof minimum === "number" && value.length < minimum) ||
        (typeof maximum === "number" && value.length > maximum)
      ) {
        throw new AcpExecutionError(
          `Elicitation field ${name} has an invalid selection count`,
          {},
          "invalid_elicitation_response",
        );
      }
      const allowed = normalizeElicitationOptions(property);
      if (
        allowed.length > 0 &&
        value.some((entry) => !allowed.some((option) => option.value === entry))
      ) {
        throw new AcpExecutionError(
          `Elicitation field ${name} contains an invalid selection`,
          {},
          "invalid_elicitation_response",
        );
      }
      validated[name] = value;
      continue;
    }
    throw new AcpExecutionError(
      `Elicitation field ${name} has the wrong type`,
      {},
      "invalid_elicitation_response",
    );
  }
  return validated;
}

abstract class AcpTurnState {
  abstract readonly commandId: string;
  abstract readonly running: boolean;
  abstract readonly activities: AcpActivityTracker;
  abstract readonly onText: (text: string) => Promise<void>;
}

class IdleAcpTurn extends AcpTurnState {
  readonly commandId = SESSION_CONTROL_COMMAND_ID;
  readonly running = false;
  readonly activities = new AcpActivityTracker(() => Promise.resolve());
  readonly onText = (): Promise<void> => Promise.resolve();
}

class RunningAcpTurn extends AcpTurnState {
  readonly commandId: string;
  readonly running = true;
  readonly activities: AcpActivityTracker;
  readonly onText: (text: string) => Promise<void>;

  constructor(
    commandId: string,
    onActivity: (activity: AcpActivity) => Promise<void>,
    onText: (text: string) => Promise<void>,
  ) {
    super();
    this.commandId = commandId;
    this.activities = new AcpActivityTracker(onActivity);
    this.onText = onText;
  }
}

class PendingPermission {
  readonly completion = Promise.withResolvers<RequestPermissionResponse>();
  readonly interactionId: string;
  readonly optionIds: ReadonlySet<string>;
  #settled = false;

  constructor(interactionId: string, optionIds: ReadonlySet<string>) {
    this.interactionId = interactionId;
    this.optionIds = optionIds;
  }

  readonly cancel = (): boolean => {
    if (this.#settled) {
      return false;
    }
    this.#settled = true;
    this.completion.resolve({ outcome: { outcome: "cancelled" } });
    return true;
  };

  readonly select = (optionId: string): boolean => {
    if (this.#settled) {
      return false;
    }
    this.#settled = true;
    this.completion.resolve({
      outcome: { optionId, outcome: "selected" },
    });
    return true;
  };
}

class PendingElicitation {
  readonly completion = Promise.withResolvers<CreateElicitationResponse>();
  readonly elicitationId: string;
  readonly interactionId: string;
  readonly requestedSchema: unknown;
  #settled = false;

  constructor(
    interactionId: string,
    elicitationId: string,
    requestedSchema: unknown,
  ) {
    this.elicitationId = elicitationId;
    this.interactionId = interactionId;
    this.requestedSchema = requestedSchema;
  }

  readonly accept = (
    content: Readonly<Record<string, ElicitationContentValue>>,
  ): boolean => {
    if (this.#settled) {
      return false;
    }
    this.#settled = true;
    this.completion.resolve({ action: "accept", content });
    return true;
  };

  readonly cancel = (): boolean => {
    if (this.#settled) {
      return false;
    }
    this.#settled = true;
    this.completion.resolve({ action: "cancel" });
    return true;
  };

  readonly decline = (): boolean => {
    if (this.#settled) {
      return false;
    }
    this.#settled = true;
    this.completion.resolve({ action: "decline" });
    return true;
  };
}

class AcpProcessSession implements AcpClientHandler {
  readonly #additionalDirectories: readonly string[];
  readonly #acceptedUrlElicitations = new Map<string, string>();
  readonly #agentId: string;
  readonly #child: ReturnType<typeof spawn>;
  readonly #connection: ClientConnection;
  readonly #cwd: string;
  readonly #getObserver: () => AcpSessionObserver;
  readonly #mobiusSessionId: string;
  readonly #pendingElicitations = new Map<string, PendingElicitation>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  readonly #processExit: Promise<void>;
  readonly #store: AcpSessionStore;
  #agentName = "";
  #agentVersion = "";
  #capabilities: SessionCapabilities = {
    additionalDirectories: false,
    audioPrompt: false,
    closeSession: false,
    deleteSession: false,
    embeddedContextPrompt: false,
    imagePrompt: false,
    listSessions: false,
    loadSession: false,
    resumeSession: false,
    unstableForkSession: false,
  };
  #commands: readonly SessionCommand[] = [];
  #configOptions: readonly SessionConfigOption[] = [];
  #nativeSessionId = "";
  #prompted = false;
  #replay:
    | { readonly kind: "idle" | "discard" }
    | { readonly kind: "capture"; readonly history: AcpHistoryReplay } = {
    kind: "idle",
  };
  #restored = false;
  #sessionTitle: string | null = null;
  #sessionUpdatedAt = "";
  #turn: AcpTurnState = new IdleAcpTurn();
  #updateTail: Promise<void> = Promise.resolve();

  private constructor(
    agent: LocalAgentDefinition,
    cwd: string,
    additionalDirectories: readonly string[],
    mobiusSessionId: string,
    getObserver: () => AcpSessionObserver,
    store: AcpSessionStore,
  ) {
    this.#additionalDirectories = [...additionalDirectories];
    this.#agentId = agent.id;
    this.#cwd = cwd;
    this.#getObserver = getObserver;
    this.#mobiusSessionId = mobiusSessionId;
    this.#store = store;
    this.#child = spawn(agent.adapterPath, [...agent.arguments], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, ...agent.environment },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdin = this.#child.stdin;
    const stdout = this.#child.stdout;
    const stderr = this.#child.stderr;
    if (stdin === null || stdout === null || stderr === null) {
      this.#child.kill("SIGKILL");
      throw new AcpExecutionError("ACP process streams are unavailable");
    }
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      process.stderr.write(`[${agent.id}-acp] ${chunk}`);
    });
    this.#processExit = new Promise<void>((resolve) => {
      this.#child.once("error", resolve);
      this.#child.once("exit", resolve);
    });
    const stream = ndJsonStream(
      createWritableAcpStream(stdin),
      readableWebStream(stdout),
    );
    this.#connection = createAcpClient(this).connect(stream);
  }

  static async #start(
    options: AcpPrepareOptions,
    getObserver: () => AcpSessionObserver,
    store: AcpSessionStore,
    initialize: (runtime: AcpProcessSession) => Promise<void>,
  ): Promise<AcpProcessSession> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      options.signal.throwIfAborted();
      const [adapterUnchanged, agentUnchanged] = await Promise.all([
        revalidateExecutable(options.agent.adapterIdentity),
        revalidateExecutable(options.agent.agentIdentity),
      ]);
      options.signal.throwIfAborted();
      if (!adapterUnchanged || !agentUnchanged) {
        throw new AcpExecutionError(
          "The local Agent runtime changed; restart Mobius before starting a new conversation",
          {},
          "agent_runtime_changed",
        );
      }
      const runtime = new AcpProcessSession(
        options.agent,
        options.cwd,
        options.additionalDirectories,
        options.sessionId,
        getObserver,
        store,
      );
      try {
        await initialize(runtime);
        return runtime;
      } catch (error) {
        await runtime.closeProcess();
        options.signal.throwIfAborted();
        if (error instanceof RetryableAcpInitializationError && attempt === 1) {
          console.warn(
            `[${options.agent.id}-acp] ACP agent initialization failed; retrying once`,
          );
          continue;
        }
        if (error instanceof AcpExecutionError) {
          throw error;
        }
        throw new AcpExecutionError("ACP agent initialization failed", {
          cause: error,
        });
      }
    }
    throw new AcpExecutionError("ACP agent initialization failed");
  }

  static readonly start = async (
    options: AcpPrepareOptions,
    getObserver: () => AcpSessionObserver,
    store: AcpSessionStore,
  ): Promise<AcpProcessSession> =>
    await AcpProcessSession.#start(
      options,
      getObserver,
      store,
      async (runtime) =>
        await runtime.initialize(options.signal, options.origin),
    );

  static readonly startNativeSessionBrowser = async (
    options: AcpPrepareOptions,
    getObserver: () => AcpSessionObserver,
    store: AcpSessionStore,
  ): Promise<AcpProcessSession> =>
    await AcpProcessSession.#start(
      options,
      getObserver,
      store,
      async (runtime) => await runtime.#initializeAgent(options.signal),
    );

  readonly belongsTo = (
    agentId: string,
    cwd: string,
    additionalDirectories: readonly string[],
  ): boolean =>
    this.#agentId === agentId &&
    this.#cwd === cwd &&
    arraysEqual(this.#additionalDirectories, additionalDirectories);

  readonly canRebind = (): boolean => !this.#prompted && !this.#turn.running;

  readonly prepared = (): AcpPreparedSession =>
    new AcpPreparedSession(
      this.#agentName,
      this.#agentVersion,
      this.#capabilities,
      this.#commands,
      this.#configOptions,
      this.#restored,
    );

  readonly loadHistory = async (
    signal: AbortSignal,
  ): Promise<NativeSessionHistory> => {
    if (!this.#capabilities.loadSession) return { status: "unavailable" };
    const history = new AcpHistoryReplay();
    this.#replay = { kind: "capture", history };
    try {
      await this.race(
        this.#connection.agent.request(
          methods.agent.session.load,
          {
            additionalDirectories: [...this.#additionalDirectories],
            cwd: this.#cwd,
            mcpServers: [],
            sessionId: this.#nativeSessionId,
          },
          { cancellationSignal: signal },
        ),
        "ACP agent exited while loading history",
        signal,
      );
      await this.#updateTail;
      signal.throwIfAborted();
      return history.snapshot();
    } finally {
      this.#replay = { kind: "idle" };
    }
  };

  async #initializeAgent(signal: AbortSignal): Promise<void> {
    const initialized = await this.race(
      this.#connection.agent.request(
        methods.agent.initialize,
        {
          clientCapabilities: {
            elicitation: { form: {}, url: {} },
            plan: {},
            session: { configOptions: { boolean: {} } },
          },
          clientInfo: { name: "mobius", version: "0.0.3" },
          protocolVersion: PROTOCOL_VERSION,
        },
        { cancellationSignal: signal },
      ),
      "ACP agent exited during initialization",
      signal,
    ).catch((cause: unknown) => {
      signal.throwIfAborted();
      throw new RetryableAcpInitializationError(cause);
    });
    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpExecutionError(
        "ACP agent selected an unsupported protocol version",
        {},
        "unsupported_acp_protocol",
      );
    }
    const capabilities = initialized.agentCapabilities ?? {};
    this.#capabilities = normalizeCapabilities(capabilities);
    this.#agentName = truncate(
      initialized.agentInfo?.title ??
        initialized.agentInfo?.name ??
        this.#agentId,
      255,
    );
    this.#agentVersion = truncate(initialized.agentInfo?.version ?? "", 128);
  }

  readonly initialize = async (
    signal: AbortSignal,
    origin?: NativeSessionOrigin,
  ): Promise<void> => {
    await this.#initializeAgent(signal);
    const stored =
      origin?.kind === "import"
        ? new FoundAcpStoredSession(
            new AcpStoredSession(
              this.#mobiusSessionId,
              this.#agentId,
              nativeSessionIdSchema.parse(origin.nativeSessionId),
              this.#cwd,
              this.#additionalDirectories,
              true,
            ),
          )
        : this.#store.read(this.#mobiusSessionId);
    if (stored instanceof DeletedAcpStoredSession)
      throw new AcpExecutionError(
        "The native Agent session was deleted. Start a new chat.",
        {},
        "native_session_deleted",
      );
    let lifecycleResponse: unknown;
    if (origin?.kind === "fork") {
      if (!this.#capabilities.unstableForkSession)
        throw new AcpExecutionError(
          "This Agent does not support session forking",
          {},
          "native_session_unsupported",
        );
      const forked = await this.race(
        this.#connection.agent.request(
          methods.agent.session.fork,
          {
            sessionId: nativeSessionIdSchema.parse(origin.nativeSessionId),
            cwd: this.#cwd,
            additionalDirectories: [...this.#additionalDirectories],
            mcpServers: [],
          },
          { cancellationSignal: signal },
        ),
        "ACP agent exited while forking a session",
        signal,
      );
      this.#nativeSessionId = nativeSessionIdSchema.parse(forked.sessionId);
      if (
        this.#nativeSessionId === origin.nativeSessionId ||
        this.#store.findNative(this.#agentId, this.#nativeSessionId).length > 0
      ) {
        throw new AcpExecutionError(
          "The Agent did not create an independent fork",
          {},
          "invalid_native_session_response",
        );
      }
      this.#prompted = true;
      this.#restored = true;
      lifecycleResponse = forked;
    } else if (
      stored instanceof FoundAcpStoredSession &&
      stored.session.agentId === this.#agentId &&
      stored.session.cwd === this.#cwd &&
      arraysEqual(
        stored.session.additionalDirectories,
        this.#additionalDirectories,
      )
    ) {
      this.#nativeSessionId = stored.session.nativeSessionId;
      this.#prompted = stored.session.prompted;
      this.#restored = true;
      if (this.#capabilities.resumeSession) {
        lifecycleResponse = await this.race(
          this.#connection.agent.request(
            methods.agent.session.resume,
            {
              additionalDirectories: [...this.#additionalDirectories],
              cwd: this.#cwd,
              mcpServers: [],
              sessionId: this.#nativeSessionId,
            },
            { cancellationSignal: signal },
          ),
          "ACP agent exited while resuming a session",
          signal,
        );
      } else if (this.#capabilities.loadSession) {
        this.#replay = { kind: "discard" };
        try {
          lifecycleResponse = await this.race(
            this.#connection.agent.request(
              methods.agent.session.load,
              {
                additionalDirectories: [...this.#additionalDirectories],
                cwd: this.#cwd,
                mcpServers: [],
                sessionId: this.#nativeSessionId,
              },
              { cancellationSignal: signal },
            ),
            "ACP agent exited while loading a session",
            signal,
          );
        } finally {
          await this.#updateTail;
          this.#replay = { kind: "idle" };
        }
      } else {
        throw new AcpExecutionError(
          "The ACP agent cannot restore its persisted session",
          {},
          "session_restore_unsupported",
        );
      }
    } else {
      if (stored instanceof FoundAcpStoredSession) {
        if (stored.session.prompted) {
          throw new AcpExecutionError(
            "The agent or workspace cannot change after a conversation has started",
            {},
            "session_identity_mismatch",
          );
        }
        this.#store.remove(this.#mobiusSessionId);
      }
      const created = await this.race(
        this.#connection.agent.request(
          methods.agent.session.new,
          {
            additionalDirectories: [...this.#additionalDirectories],
            cwd: this.#cwd,
            mcpServers: [],
          },
          { cancellationSignal: signal },
        ),
        "ACP agent exited while starting a session",
        signal,
      );
      this.#nativeSessionId = created.sessionId;
      lifecycleResponse = created;
      this.#store.write(
        new AcpStoredSession(
          this.#mobiusSessionId,
          this.#agentId,
          this.#nativeSessionId,
          this.#cwd,
          this.#additionalDirectories,
          false,
        ),
      );
    }
    const lifecycleRecord = isRecord(lifecycleResponse)
      ? lifecycleResponse
      : {};
    this.#configOptions = normalizeConfigOptions(
      lifecycleRecord["configOptions"],
      lifecycleRecord["modes"],
    );
    await this.#updateTail;
    signal.throwIfAborted();
    this.#store.write(
      new AcpStoredSession(
        this.#mobiusSessionId,
        this.#agentId,
        this.#nativeSessionId,
        this.#cwd,
        this.#additionalDirectories,
        this.#prompted,
      ),
    );
  };

  readonly listNativeSessions = async (
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<NativeSessionPage> => {
    if (!this.#capabilities.listSessions)
      throw new AcpExecutionError(
        "This Agent does not support native session listing",
        {},
        "native_session_unsupported",
      );
    const response: unknown = await this.race(
      this.#connection.agent.request(
        methods.agent.session.list,
        cursor === null ? {} : { cursor },
        { cancellationSignal: signal },
      ),
      "ACP agent exited while listing sessions",
      signal,
    );
    const decoded = nativeSessionPageSchema.safeParse(response);
    if (!decoded.success)
      throw new AcpExecutionError(
        "The Agent returned an invalid native session list",
        { cause: decoded.error },
        "invalid_native_session_response",
      );
    return decoded.data;
  };

  readonly deleteNativeSession = async (
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!this.#capabilities.deleteSession || !this.#capabilities.listSessions)
      throw new AcpExecutionError(
        "This Agent does not support native session deletion",
        {},
        "native_session_unsupported",
      );
    await this.race(
      this.#connection.agent.request(
        methods.agent.session.delete,
        { sessionId: nativeSessionIdSchema.parse(nativeSessionId) },
        { cancellationSignal: signal },
      ),
      "ACP agent exited while deleting a session",
      signal,
    );
  };

  readonly nativeSessionId = (): string => this.#nativeSessionId;

  readonly configure = async (
    options: AcpConfigureOptions,
  ): Promise<readonly SessionConfigOption[]> => {
    const existing = this.#configOptions.find(
      (option) => option.id === options.configId,
    );
    if (existing === undefined || existing.type !== options.valueType) {
      throw new AcpExecutionError(
        "The requested ACP configuration option is unavailable",
        {},
        "invalid_session_configuration",
      );
    }
    if (existing.type === "select") {
      if (!existing.values.some((entry) => entry.value === options.value)) {
        throw new AcpExecutionError(
          "The requested ACP configuration value is unavailable",
          {},
          "invalid_session_configuration",
        );
      }
      if (existing.category === "mode") {
        await this.race(
          this.#connection.agent.request(
            methods.agent.session.setMode,
            { modeId: options.value, sessionId: this.#nativeSessionId },
            { cancellationSignal: options.signal },
          ),
          "ACP agent exited while setting the session mode",
          options.signal,
        );
        this.#configOptions = this.#configOptions.map((option) =>
          option.id === existing.id
            ? { ...option, currentValue: options.value }
            : option,
        );
      } else {
        const response = await this.race(
          this.#connection.agent.request(
            methods.agent.session.setConfigOption,
            {
              configId: existing.id,
              sessionId: this.#nativeSessionId,
              value: options.value,
            },
            { cancellationSignal: options.signal },
          ),
          "ACP agent exited while changing session configuration",
          options.signal,
        );
        this.#configOptions = replaceConfigOptionsKeepingMode(
          this.#configOptions,
          response.configOptions,
        );
      }
    } else {
      const response = await this.race(
        this.#connection.agent.request(
          methods.agent.session.setConfigOption,
          {
            configId: existing.id,
            sessionId: this.#nativeSessionId,
            type: "boolean",
            value: options.booleanValue,
          },
          { cancellationSignal: options.signal },
        ),
        "ACP agent exited while changing session configuration",
        options.signal,
      );
      this.#configOptions = replaceConfigOptionsKeepingMode(
        this.#configOptions,
        response.configOptions,
      );
    }
    return this.#configOptions;
  };

  readonly prompt = async (
    options: AcpTurnOptions,
  ): Promise<AcpPromptResult> => {
    if (this.#turn.running) {
      throw new AcpExecutionError(
        "Another prompt is already running in this conversation",
        {},
        "session_busy",
      );
    }
    if (options.images.length > 0 && !this.#capabilities.imagePrompt) {
      throw new AcpExecutionError(
        "The selected agent does not accept image prompts",
        {},
        "unsupported_prompt_content",
      );
    }
    if (
      options.resources.some((resource) => resource.type === "embedded") &&
      !this.#capabilities.embeddedContextPrompt
    ) {
      throw new AcpExecutionError(
        "The selected agent does not accept embedded context",
        {},
        "unsupported_prompt_content",
      );
    }
    const prompt: ContentBlock[] = [];
    if (options.prompt.length > 0) {
      prompt.push({ text: options.prompt, type: "text" });
    }
    for (const image of options.images) {
      prompt.push({
        _meta: { mobius: { name: image.name } },
        data: image.data,
        mimeType: image.mimeType,
        type: "image",
      });
    }
    for (const resource of options.resources) {
      if (resource.type === "embedded") {
        prompt.push({
          resource: {
            mimeType: resource.mimeType,
            text: resource.text,
            uri: resource.uri,
          },
          type: "resource",
        });
      } else {
        prompt.push({
          mimeType: resource.mimeType,
          name: resource.name,
          type: "resource_link",
          uri: resource.uri,
        });
      }
    }
    if (prompt.length === 0) {
      throw new AcpExecutionError(
        "A prompt must contain text or an attachment",
        {},
        "empty_prompt",
      );
    }
    this.#store.write(
      new AcpStoredSession(
        this.#mobiusSessionId,
        this.#agentId,
        this.#nativeSessionId,
        this.#cwd,
        this.#additionalDirectories,
        true,
      ),
    );
    this.#prompted = true;
    const running = new RunningAcpTurn(
      options.commandId,
      options.onActivity,
      options.onText,
    );
    this.#turn = running;
    try {
      const response: unknown = await this.race(
        this.#connection.agent.request(
          methods.agent.session.prompt,
          { prompt, sessionId: this.#nativeSessionId },
          { cancellationSignal: options.signal },
        ),
        "ACP agent exited during a prompt",
        options.signal,
      );
      await this.#updateTail;
      await running.activities.finish();
      let result: AcpPromptResult;
      try {
        result = decodeAgentPromptResponse(response);
      } catch (cause) {
        throw new AcpExecutionError(
          "ACP agent returned an invalid prompt response",
          { cause },
          "acp_invalid_prompt_response",
        );
      }
      if (result.usage != null || result._meta?.quota !== undefined) {
        await this.#getObserver().onUsage({
          _meta: result._meta ?? null,
          commandId: options.commandId,
          kind: SESSION_USAGE_UPDATED_KIND,
          sessionId: this.#mobiusSessionId,
          source: "prompt",
          usage: result.usage ?? null,
        });
      }
      return result;
    } catch (error) {
      await running.activities.finish();
      if (error instanceof AcpExecutionError) {
        throw error;
      }
      throw new AcpExecutionError("ACP agent execution failed", {
        cause: error,
      });
    } finally {
      this.#turn = new IdleAcpTurn();
    }
  };

  readonly cancel = async (): Promise<void> => {
    await this.cancelPendingInteractions();
    if (!this.#turn.running) {
      return;
    }
    await this.#connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.#nativeSessionId,
    });
  };

  readonly respondPermission = async (
    options: AcpPermissionResponseOptions,
  ): Promise<void> => {
    const pending = this.#pendingPermissions.get(options.interactionId);
    if (pending === undefined) {
      throw new AcpExecutionError(
        "The permission request is no longer active",
        {},
        "permission_request_not_found",
      );
    }
    if (
      options.outcome === "selected" &&
      !pending.optionIds.has(options.optionId)
    ) {
      throw new AcpExecutionError(
        "The selected permission option is unavailable",
        {},
        "invalid_permission_response",
      );
    }
    const resolved =
      options.outcome === "selected"
        ? pending.select(options.optionId)
        : pending.cancel();
    if (!resolved) {
      throw new AcpExecutionError(
        "The permission request was already resolved",
        {},
        "permission_request_not_found",
      );
    }
    this.#pendingPermissions.delete(options.interactionId);
    await this.#getObserver().onPermissionResolved({
      interactionId: options.interactionId,
      kind: SESSION_PERMISSION_RESOLVED_KIND,
      optionId: options.outcome === "selected" ? options.optionId : "",
      outcome: options.outcome,
      sessionId: this.#mobiusSessionId,
    });
  };

  readonly respondElicitation = async (
    options: AcpElicitationResponseOptions,
  ): Promise<void> => {
    const pending = this.#pendingElicitations.get(options.interactionId);
    if (pending === undefined) {
      throw new AcpExecutionError(
        "The elicitation request is no longer active",
        {},
        "elicitation_request_not_found",
      );
    }
    let resolved = false;
    if (options.action === "accept") {
      if (pending.elicitationId.length > 0) {
        resolved = pending.accept({});
        if (resolved) {
          this.#acceptedUrlElicitations.set(
            pending.elicitationId,
            pending.interactionId,
          );
        }
      } else {
        resolved = pending.accept(
          validateElicitationContent(options.content, pending.requestedSchema),
        );
      }
    } else if (options.action === "decline") {
      resolved = pending.decline();
    } else {
      resolved = pending.cancel();
    }
    if (!resolved) {
      throw new AcpExecutionError(
        "The elicitation request was already resolved",
        {},
        "elicitation_request_not_found",
      );
    }
    this.#pendingElicitations.delete(options.interactionId);
    await this.#getObserver().onElicitationResolved({
      action: options.action,
      interactionId: options.interactionId,
      kind: SESSION_ELICITATION_RESOLVED_KIND,
      sessionId: this.#mobiusSessionId,
    });
  };

  readonly onPermission = async (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> => {
    this.assertNativeSession(request.sessionId);
    const interactionId = `permission-${crypto.randomUUID()}`;
    const options: SessionPermissionOption[] = request.options
      .slice(0, 20)
      .map((option) => ({
        kind: option.kind,
        name: truncate(option.name, 255),
        optionId: truncate(option.optionId, 255),
      }));
    if (options.length === 0) {
      throw new AcpExecutionError(
        "ACP permission request did not provide any choices",
        {},
        "invalid_agent_permission_request",
      );
    }
    const pending = new PendingPermission(
      interactionId,
      new Set(options.map((option) => option.optionId)),
    );
    this.#pendingPermissions.set(interactionId, pending);
    const abort = (): void => {
      void this.cancelPermission(interactionId);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.#getObserver().onPermission({
        commandId: this.#turn.commandId,
        interactionId,
        kind: SESSION_PERMISSION_REQUESTED_KIND,
        options,
        sessionId: this.#mobiusSessionId,
        title: truncate(request.toolCall.title ?? "Permission required", 500),
        toolCallId: truncate(request.toolCall.toolCallId, 255),
        toolKind: truncate(request.toolCall.kind ?? "other", 64),
      });
      return await pending.completion.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      this.#pendingPermissions.delete(interactionId);
    }
  };

  readonly onElicitation = async (
    request: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> => {
    const sessionId = Reflect.get(request, "sessionId");
    if (typeof sessionId !== "string") {
      throw new AcpExecutionError(
        "Mobius only accepts session-scoped ACP elicitations",
        {},
        "unsupported_elicitation_scope",
      );
    }
    this.assertNativeSession(sessionId);
    if (request.mode !== "form" && request.mode !== "url") {
      throw new AcpExecutionError(
        "The ACP agent requested an unsupported elicitation mode",
        {},
        "unsupported_elicitation_mode",
      );
    }
    const interactionId = `elicitation-${crypto.randomUUID()}`;
    const schemaValue = Reflect.get(request, "requestedSchema");
    const requestedSchema = request.mode === "form" ? schemaValue : {};
    const elicitationIdValue = Reflect.get(request, "elicitationId");
    const elicitationId =
      request.mode === "url" && typeof elicitationIdValue === "string"
        ? truncate(elicitationIdValue, 255)
        : "";
    const pending = new PendingElicitation(
      interactionId,
      elicitationId,
      requestedSchema,
    );
    this.#pendingElicitations.set(interactionId, pending);
    const abort = (): void => {
      void this.cancelElicitation(interactionId);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.#getObserver().onElicitation({
        accepted: false,
        commandId: this.#turn.commandId,
        elicitationId,
        fields: normalizeElicitationFields(requestedSchema),
        interactionId,
        kind: SESSION_ELICITATION_REQUESTED_KIND,
        message: truncate(request.message, 2_000),
        mode: request.mode,
        sessionId: this.#mobiusSessionId,
        url:
          request.mode === "url" &&
          typeof Reflect.get(request, "url") === "string"
            ? truncate(readString(Reflect.get(request, "url")), 4_096)
            : "",
      });
      return await pending.completion.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      this.#pendingElicitations.delete(interactionId);
    }
  };

  readonly onElicitationComplete = async (
    notification: CompleteElicitationNotification,
  ): Promise<void> => {
    const interactionId = this.#acceptedUrlElicitations.get(
      notification.elicitationId,
    );
    if (interactionId === undefined) {
      return;
    }
    this.#acceptedUrlElicitations.delete(notification.elicitationId);
    await this.#getObserver().onElicitationResolved({
      action: "complete",
      interactionId,
      kind: SESSION_ELICITATION_RESOLVED_KIND,
      sessionId: this.#mobiusSessionId,
    });
  };

  readonly onUpdate = (notification: SessionNotification): Promise<void> => {
    this.#updateTail = this.#updateTail.then(
      async () => await this.processUpdate(notification),
    );
    return this.#updateTail;
  };

  readonly processUpdate = async (
    notification: SessionNotification,
  ): Promise<void> => {
    this.assertNativeSession(notification.sessionId);
    const update = notification.update;
    if (this.#replay.kind === "capture") this.#replay.history.record(update);
    if (
      this.#replay.kind !== "idle" &&
      (update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk" ||
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "tool_call_update" ||
        update.sessionUpdate === "plan" ||
        update.sessionUpdate === "plan_update" ||
        update.sessionUpdate === "plan_removed")
    ) {
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        if (isProgressMessage(update)) {
          await this.#turn.activities.recordNarrative(
            "progress",
            update.messageId ?? "current",
            update.content.text,
          );
        } else {
          await this.#turn.activities.finishNarrative();
          await this.#turn.onText(update.content.text);
        }
      } else {
        await this.#turn.activities.finishNarrative();
        await this.#getObserver().onContent({
          commandId: this.#turn.commandId,
          content: normalizeContentBlock(update.content),
          contentId: `content-${crypto.randomUUID()}`,
          kind: AGENT_CONTENT_KIND,
          messageId: truncate(update.messageId ?? "", 255),
          sessionId: this.#mobiusSessionId,
        });
      }
      return;
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      if (update.content.type === "text") {
        await this.#turn.activities.recordNarrative(
          "reasoning",
          update.messageId ?? "current",
          update.content.text,
        );
      }
      return;
    }
    if (update.sessionUpdate === "tool_call") {
      await this.#turn.activities.recordToolCall(update);
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      await this.#turn.activities.recordToolCallUpdate(update);
      return;
    }
    if (update.sessionUpdate === "plan") {
      await this.#turn.activities.recordPlan(update);
      return;
    }
    if (update.sessionUpdate === "plan_update") {
      await this.#turn.activities.recordPlanUpdate(update);
      return;
    }
    if (update.sessionUpdate === "plan_removed") {
      await this.#turn.activities.removePlan(update);
      return;
    }
    if (update.sessionUpdate === "available_commands_update") {
      const commands: SessionCommand[] = update.availableCommands
        .slice(0, 500)
        .map((command) => ({
          description: truncate(command.description, 500),
          inputHint: truncate(command.input?.hint ?? "", 255),
          name: truncate(command.name, 128),
        }))
        .filter((command) => command.name.length > 0);
      this.#commands = commands;
      await this.#getObserver().onCommands({
        commands,
        kind: SESSION_COMMANDS_UPDATED_KIND,
        sessionId: this.#mobiusSessionId,
      });
      return;
    }
    if (update.sessionUpdate === "config_option_update") {
      this.#configOptions = replaceConfigOptionsKeepingMode(
        this.#configOptions,
        update.configOptions,
      );
      await this.emitConfigUpdate();
      return;
    }
    if (update.sessionUpdate === "current_mode_update") {
      this.#configOptions = this.#configOptions.map((option) =>
        option.category === "mode"
          ? { ...option, currentValue: update.currentModeId }
          : option,
      );
      await this.emitConfigUpdate();
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      if (Object.hasOwn(update, "title")) {
        this.#sessionTitle = truncate(update.title ?? "", 500);
      }
      if (Object.hasOwn(update, "updatedAt")) {
        this.#sessionUpdatedAt = truncate(update.updatedAt ?? "", 128);
      }
      await this.#getObserver().onInfo({
        kind: SESSION_INFO_UPDATED_KIND,
        sessionId: this.#mobiusSessionId,
        title: this.#sessionTitle,
        updatedAt: this.#sessionUpdatedAt,
      });
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      await this.#getObserver().onUsage({
        costAmount: update.cost?.amount ?? 0,
        costCurrency: truncate(update.cost?.currency ?? "", 16),
        hasCost: update.cost !== undefined && update.cost !== null,
        kind: SESSION_USAGE_UPDATED_KIND,
        sessionId: this.#mobiusSessionId,
        size: Math.max(0, Math.trunc(update.size)),
        source: "context",
        used: Math.max(0, Math.trunc(update.used)),
      });
    }
  };

  readonly close = async (): Promise<void> => {
    await this.cancelPendingInteractions();
    if (this.#capabilities.closeSession && this.#nativeSessionId.length > 0) {
      try {
        await this.#connection.agent.request(
          methods.agent.session.close,
          { sessionId: this.#nativeSessionId },
          {
            cancellationSignal: AbortSignal.timeout(
              PROCESS_STOP_TIMEOUT_MILLISECONDS,
            ),
          },
        );
      } catch {
        // Process teardown below remains authoritative.
      }
    }
    await this.closeProcess();
  };

  readonly closeProcess = async (): Promise<void> => {
    this.#connection.close();
    await stopProcessTree(this.#child);
  };

  readonly race = async <T>(
    operation: Promise<T>,
    exitMessage: string,
    signal: AbortSignal,
  ): Promise<T> => {
    signal.throwIfAborted();
    let removeAbortListener = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        reject(signal.reason ?? new Error("ACP request was cancelled"));
      };
      signal.addEventListener("abort", rejectAbort, { once: true });
      removeAbortListener = (): void => {
        signal.removeEventListener("abort", rejectAbort);
      };
    });
    try {
      return await Promise.race([
        operation,
        this.#processExit.then(() => {
          throw new AcpExecutionError(exitMessage);
        }),
        aborted,
      ]);
    } finally {
      removeAbortListener();
    }
  };

  readonly assertNativeSession = (sessionId: string): void => {
    if (sessionId !== this.#nativeSessionId) {
      throw new AcpExecutionError(
        "ACP agent referenced an unknown session",
        {},
        "invalid_agent_session",
      );
    }
  };

  readonly emitConfigUpdate = async (): Promise<void> => {
    await this.#getObserver().onConfig({
      configOptions: this.#configOptions,
      kind: SESSION_CONFIG_UPDATED_KIND,
      requestId: `agent-update-${crypto.randomUUID()}`,
      sessionId: this.#mobiusSessionId,
    });
  };

  readonly cancelPermission = async (interactionId: string): Promise<void> => {
    const pending = this.#pendingPermissions.get(interactionId);
    if (pending === undefined || !pending.cancel()) {
      return;
    }
    this.#pendingPermissions.delete(interactionId);
    await this.#getObserver().onPermissionResolved({
      interactionId,
      kind: SESSION_PERMISSION_RESOLVED_KIND,
      optionId: "",
      outcome: "cancelled",
      sessionId: this.#mobiusSessionId,
    });
  };

  readonly cancelElicitation = async (interactionId: string): Promise<void> => {
    const pending = this.#pendingElicitations.get(interactionId);
    if (pending === undefined || !pending.cancel()) {
      return;
    }
    this.#pendingElicitations.delete(interactionId);
    await this.#getObserver().onElicitationResolved({
      action: "cancel",
      interactionId,
      kind: SESSION_ELICITATION_RESOLVED_KIND,
      sessionId: this.#mobiusSessionId,
    });
  };

  readonly cancelPendingInteractions = async (): Promise<void> => {
    const permissionIds = [...this.#pendingPermissions.keys()];
    const elicitationIds = [...this.#pendingElicitations.keys()];
    const acceptedElicitationIds = [...this.#acceptedUrlElicitations.values()];
    this.#acceptedUrlElicitations.clear();
    for (const interactionId of permissionIds) {
      await this.cancelPermission(interactionId);
    }
    for (const interactionId of elicitationIds) {
      await this.cancelElicitation(interactionId);
    }
    for (const interactionId of acceptedElicitationIds) {
      await this.#getObserver().onElicitationResolved({
        action: "cancel",
        interactionId,
        kind: SESSION_ELICITATION_RESOLVED_KIND,
        sessionId: this.#mobiusSessionId,
      });
    }
  };
}

export class AcpSessionManager {
  readonly #nativeOperations = new Set<string>();
  readonly #nativeBrowserObserver = new NullAcpSessionObserver();
  readonly #nativeBrowserPreparing = new Map<
    string,
    Promise<AcpProcessSession>
  >();
  readonly #nativeBrowserSessions = new Map<string, AcpProcessSession>();
  readonly #nativeBrowserStore = new MemoryAcpSessionStore();
  readonly #activeSessionIds = new Set<string>();
  readonly #cancellationRequests = new Set<string>();
  readonly #preparing = new Map<string, Promise<AcpProcessSession>>();
  readonly #sessions = new Map<string, AcpProcessSession>();
  readonly #store: AcpSessionStore;
  #observer: AcpSessionObserver;

  constructor(
    observer: AcpSessionObserver = new NullAcpSessionObserver(),
    store: AcpSessionStore = new MemoryAcpSessionStore(),
  ) {
    this.#observer = observer;
    this.#store = store;
  }

  readonly setObserver = (observer: AcpSessionObserver): void => {
    this.#observer = observer;
  };

  async #startNativeBrowserPreparation(
    options: AcpPrepareOptions,
  ): Promise<AcpProcessSession> {
    const operation = (async () => {
      try {
        const runtime = await AcpProcessSession.startNativeSessionBrowser(
          options,
          () => this.#nativeBrowserObserver,
          this.#nativeBrowserStore,
        );
        this.#nativeBrowserSessions.set(options.sessionId, runtime);
        return runtime;
      } finally {
        this.#nativeBrowserPreparing.delete(options.sessionId);
      }
    })();
    this.#nativeBrowserPreparing.set(options.sessionId, operation);
    return await operation;
  }

  async #replaceNativeBrowserPreparation(
    existing: AcpProcessSession,
    options: AcpPrepareOptions,
  ): Promise<AcpProcessSession> {
    const operation = (async () => {
      try {
        this.#nativeBrowserSessions.delete(options.sessionId);
        await existing.close();
        this.#nativeBrowserStore.remove(options.sessionId);
        const runtime = await AcpProcessSession.startNativeSessionBrowser(
          options,
          () => this.#nativeBrowserObserver,
          this.#nativeBrowserStore,
        );
        this.#nativeBrowserSessions.set(options.sessionId, runtime);
        return runtime;
      } finally {
        this.#nativeBrowserPreparing.delete(options.sessionId);
      }
    })();
    this.#nativeBrowserPreparing.set(options.sessionId, operation);
    return await operation;
  }

  async #startPreparation(
    options: AcpPrepareOptions,
  ): Promise<AcpProcessSession> {
    const operation = (async () => {
      try {
        const runtime = await AcpProcessSession.start(
          options,
          () => this.#observer,
          this.#store,
        );
        this.#sessions.set(options.sessionId, runtime);
        return runtime;
      } finally {
        this.#preparing.delete(options.sessionId);
      }
    })();
    this.#preparing.set(options.sessionId, operation);
    return await operation;
  }

  async #replacePreparation(
    existing: AcpProcessSession,
    options: AcpPrepareOptions,
  ): Promise<AcpProcessSession> {
    const operation = (async () => {
      try {
        this.#sessions.delete(options.sessionId);
        await existing.close();
        this.#store.remove(options.sessionId);
        const runtime = await AcpProcessSession.start(
          options,
          () => this.#observer,
          this.#store,
        );
        this.#sessions.set(options.sessionId, runtime);
        return runtime;
      } finally {
        this.#preparing.delete(options.sessionId);
      }
    })();
    this.#preparing.set(options.sessionId, operation);
    return await operation;
  }

  readonly prepareSession = async (
    options: AcpPrepareOptions,
  ): Promise<AcpPreparedSession> => {
    const stored = this.#store.read(options.sessionId);
    if (stored instanceof DeletedAcpStoredSession)
      throw new AcpExecutionError(
        "The native Agent session was deleted. Start a new chat.",
        {},
        "native_session_deleted",
      );
    if (
      stored instanceof FoundAcpStoredSession &&
      this.#nativeOperations.has(
        `${stored.session.agentId}:${stored.session.nativeSessionId}`,
      )
    )
      throw new AcpExecutionError(
        "The native session is being managed",
        {},
        "session_busy",
      );
    const pending = this.#preparing.get(options.sessionId);
    if (pending !== undefined) {
      const runtime = await pending;
      if (
        runtime.belongsTo(
          options.agent.id,
          options.cwd,
          options.additionalDirectories,
        )
      ) {
        return runtime.prepared();
      }
      return await this.prepareSession(options);
    }
    const existing = this.#sessions.get(options.sessionId);
    if (existing !== undefined) {
      if (
        existing.belongsTo(
          options.agent.id,
          options.cwd,
          options.additionalDirectories,
        )
      ) {
        return existing.prepared();
      }
      if (!existing.canRebind()) {
        throw new AcpExecutionError(
          "The agent or workspace cannot change after a conversation has started",
          {},
          "session_identity_mismatch",
        );
      }
      const runtime = await this.#replacePreparation(existing, options);
      return runtime.prepared();
    }
    const runtime = await this.#startPreparation(options);
    return runtime.prepared();
  };

  readonly prepareNativeSessionBrowser = async (
    options: AcpPrepareOptions,
  ): Promise<AcpPreparedSession> => {
    const pending = this.#nativeBrowserPreparing.get(options.sessionId);
    if (pending !== undefined) {
      const runtime = await pending;
      if (
        runtime.belongsTo(
          options.agent.id,
          options.cwd,
          options.additionalDirectories,
        )
      ) {
        return runtime.prepared();
      }
      return await this.prepareNativeSessionBrowser(options);
    }
    const existing = this.#nativeBrowserSessions.get(options.sessionId);
    if (existing !== undefined) {
      if (
        existing.belongsTo(
          options.agent.id,
          options.cwd,
          options.additionalDirectories,
        )
      ) {
        return existing.prepared();
      }
      if (!existing.canRebind()) {
        throw new AcpExecutionError(
          "The agent or workspace cannot change after a conversation has started",
          {},
          "session_identity_mismatch",
        );
      }
      const runtime = await this.#replaceNativeBrowserPreparation(
        existing,
        options,
      );
      return runtime.prepared();
    }
    const runtime = await this.#startNativeBrowserPreparation(options);
    return runtime.prepared();
  };

  readonly configureSession = async (
    options: AcpConfigureOptions,
  ): Promise<readonly SessionConfigOption[]> => {
    const runtime = await this.ensureSession(options);
    return await runtime.configure(options);
  };

  readonly cancelPrompt = async (sessionId: string): Promise<void> => {
    this.#cancellationRequests.add(sessionId);
    const runtime = this.#sessions.get(sessionId);
    if (runtime !== undefined) {
      await runtime.cancel();
    }
  };

  readonly runPrompt = async (
    options: AcpTurnOptions,
  ): Promise<AcpPromptResult> => {
    const stored = this.#store.read(options.sessionId);
    if (
      stored instanceof FoundAcpStoredSession &&
      this.#nativeOperations.has(
        `${stored.session.agentId}:${stored.session.nativeSessionId}`,
      )
    ) {
      throw new AcpExecutionError(
        "The native session is being managed",
        {},
        "session_busy",
      );
    }
    if (this.#activeSessionIds.has(options.sessionId)) {
      throw new AcpExecutionError(
        "Another prompt is already running in this conversation",
        {},
        "session_busy",
      );
    }
    this.#activeSessionIds.add(options.sessionId);
    try {
      if (this.#cancellationRequests.has(options.sessionId)) {
        return { stopReason: "cancelled" };
      }
      const runtime = await this.ensureSession(options);
      if (
        this.#nativeOperations.has(
          `${options.agent.id}:${runtime.nativeSessionId()}`,
        )
      )
        throw new AcpExecutionError(
          "The native session is being managed",
          {},
          "session_busy",
        );
      if (this.#cancellationRequests.has(options.sessionId)) {
        return { stopReason: "cancelled" };
      }
      return await runtime.prompt(options);
    } catch (error) {
      const failedRuntime = this.#sessions.get(options.sessionId);
      if (failedRuntime !== undefined) {
        this.#sessions.delete(options.sessionId);
        await failedRuntime.close();
      }
      if (error instanceof AcpExecutionError) {
        throw error;
      }
      throw new AcpExecutionError("ACP agent execution failed", {
        cause: error,
      });
    } finally {
      this.#activeSessionIds.delete(options.sessionId);
      this.#cancellationRequests.delete(options.sessionId);
    }
  };

  readonly respondPermission = async (
    options: AcpPermissionResponseOptions,
  ): Promise<void> => {
    const runtime = this.#sessions.get(options.sessionId);
    if (runtime === undefined) {
      throw new AcpExecutionError(
        "The permission request session is unavailable",
        {},
        "session_not_found",
      );
    }
    await runtime.respondPermission(options);
  };

  readonly respondElicitation = async (
    options: AcpElicitationResponseOptions,
  ): Promise<void> => {
    const runtime = this.#sessions.get(options.sessionId);
    if (runtime === undefined) {
      throw new AcpExecutionError(
        "The elicitation request session is unavailable",
        {},
        "session_not_found",
      );
    }
    await runtime.respondElicitation(options);
  };

  readonly close = async (): Promise<void> => {
    const sessions = [...this.#sessions.values()];
    const nativeBrowserSessions = [...this.#nativeBrowserSessions.values()];
    this.#sessions.clear();
    this.#nativeBrowserSessions.clear();
    await Promise.all(
      [...sessions, ...nativeBrowserSessions].map(
        async (session) => await session.close(),
      ),
    );
  };

  readonly ensureSession = async (
    options: AcpPrepareOptions,
  ): Promise<AcpProcessSession> => {
    const existing = this.#sessions.get(options.sessionId);
    if (existing !== undefined) {
      if (
        !existing.belongsTo(
          options.agent.id,
          options.cwd,
          options.additionalDirectories,
        )
      ) {
        throw new AcpExecutionError(
          "The agent or workspace cannot change after a conversation has started",
          {},
          "session_identity_mismatch",
        );
      }
      return existing;
    }
    await this.prepareSession(options);
    const started = this.#sessions.get(options.sessionId);
    if (started === undefined) {
      throw new AcpExecutionError("ACP session did not start");
    }
    return started;
  };

  async #ensureNativeSessionBrowser(
    options: AcpPrepareOptions,
  ): Promise<AcpProcessSession> {
    const existing = this.#nativeBrowserSessions.get(options.sessionId);
    if (existing !== undefined) {
      if (
        !existing.belongsTo(
          options.agent.id,
          options.cwd,
          options.additionalDirectories,
        )
      ) {
        throw new AcpExecutionError(
          "The agent or workspace cannot change after a conversation has started",
          {},
          "session_identity_mismatch",
        );
      }
      return existing;
    }
    await this.prepareNativeSessionBrowser(options);
    const started = this.#nativeBrowserSessions.get(options.sessionId);
    if (started === undefined) {
      throw new AcpExecutionError("ACP native session browser did not start");
    }
    return started;
  }

  readonly listNativeSessions = async (
    options: AcpPrepareOptions,
    cursor: string | null,
  ): Promise<NativeSessionPage> =>
    await (await this.#ensureNativeSessionBrowser(options)).listNativeSessions(
      cursor,
      options.signal,
    );

  readonly openNativeSession = async (
    options: AcpPrepareOptions,
    origin: NativeSessionOrigin,
  ): Promise<{
    readonly sessionId: string;
    readonly prepared: AcpPreparedSession;
    readonly history: NativeSessionHistory;
  }> => {
    const key = `${options.agent.id}:${origin.nativeSessionId}`;
    if (this.#nativeOperations.has(key))
      throw new AcpExecutionError(
        "The native session is being managed",
        {},
        "session_busy",
      );
    const linked = this.#store.findNative(
      options.agent.id,
      origin.nativeSessionId,
    );
    if (
      linked.some(
        (entry) =>
          this.#activeSessionIds.has(entry.sessionId) ||
          this.#preparing.has(entry.sessionId),
      )
    )
      throw new AcpExecutionError(
        "Wait for the native session's running operation to finish",
        {},
        "session_busy",
      );
    const existing = linked[0];
    if (origin.kind === "import" && existing !== undefined) {
      const runtime = await this.ensureSession({
        ...options,
        sessionId: existing.sessionId,
      });
      if (
        this.#activeSessionIds.has(existing.sessionId) ||
        this.#nativeOperations.has(key)
      )
        throw new AcpExecutionError(
          "Wait for the native session's running operation to finish",
          {},
          "session_busy",
        );
      this.#nativeOperations.add(key);
      try {
        const history = await runtime.loadHistory(options.signal);
        return {
          prepared: runtime.prepared(),
          sessionId: existing.sessionId,
          history,
        };
      } catch (error) {
        this.#sessions.delete(existing.sessionId);
        await runtime.closeProcess();
        throw error;
      } finally {
        this.#nativeOperations.delete(key);
      }
    }
    if (
      this.#sessions.has(options.sessionId) ||
      this.#preparing.has(options.sessionId) ||
      this.#store.read(options.sessionId) instanceof FoundAcpStoredSession ||
      this.#store.read(options.sessionId) instanceof DeletedAcpStoredSession
    )
      throw new AcpExecutionError(
        "The destination conversation already exists",
        {},
        "session_identity_mismatch",
      );
    this.#nativeOperations.add(key);
    try {
      const runtime = await this.#startPreparation({ ...options, origin });
      const openedKey = `${options.agent.id}:${runtime.nativeSessionId()}`;
      this.#nativeOperations.add(openedKey);
      try {
        const history = await runtime.loadHistory(options.signal);
        return {
          sessionId: options.sessionId,
          prepared: runtime.prepared(),
          history,
        };
      } catch (error) {
        this.#sessions.delete(options.sessionId);
        this.#store.remove(options.sessionId);
        await runtime.closeProcess();
        throw error;
      } finally {
        this.#nativeOperations.delete(openedKey);
      }
    } finally {
      this.#nativeOperations.delete(key);
    }
  };

  readonly deleteNativeSession = async (
    options: AcpPrepareOptions,
    nativeSessionId: string,
  ): Promise<readonly string[]> => {
    const runtime = await this.#ensureNativeSessionBrowser(options);
    const key = `${options.agent.id}:${nativeSessionId}`;
    const linked = this.#store.findNative(options.agent.id, nativeSessionId);
    if (
      this.#nativeOperations.has(key) ||
      linked.some(
        (entry) =>
          this.#activeSessionIds.has(entry.sessionId) ||
          this.#preparing.has(entry.sessionId),
      )
    )
      throw new AcpExecutionError(
        "Wait for the native session's running operation to finish",
        {},
        "session_busy",
      );
    this.#nativeOperations.add(key);
    try {
      for (const entry of linked) {
        const active = this.#sessions.get(entry.sessionId);
        if (active !== undefined && active !== runtime) {
          this.#sessions.delete(entry.sessionId);
          await active.close();
        }
      }
      options.signal.throwIfAborted();
      await runtime.deleteNativeSession(nativeSessionId, options.signal);
      const deleted = this.#store.markDeleted(
        options.agent.id,
        nativeSessionId,
      );
      if (runtime.nativeSessionId() === nativeSessionId) {
        this.#nativeBrowserSessions.delete(options.sessionId);
        this.#nativeBrowserStore.remove(options.sessionId);
        await runtime.close();
      }
      return deleted;
    } finally {
      this.#nativeOperations.delete(key);
    }
  };
}
