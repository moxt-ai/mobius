import {
  MOBIUS_PROTOCOL_VERSION,
  type NativeSessionHistory,
  type SessionCommandsUpdatedEvent,
  type SessionConfigOption,
  type SessionConfigUpdatedEvent,
  type SessionElicitationRequestedEvent,
  type SessionElicitationResolvedEvent,
  type SessionInfoUpdatedEvent,
  type SessionPermissionRequestedEvent,
  type SessionPermissionResolvedEvent,
  type SessionReadyEvent,
  type SessionUsageUpdatedEvent,
} from "@moxt-ai/mobius-protocol";

export class RecordedSession {
  readonly additionalDirectories: SessionReadyEvent["additionalDirectories"];
  readonly agentId: string;
  readonly agentName: string;
  readonly agentVersion: string;
  readonly capabilities: SessionReadyEvent["capabilities"];
  readonly commands: SessionCommandsUpdatedEvent["commands"];
  readonly configOptions: readonly SessionConfigOption[];
  readonly directoryId: string;
  readonly directoryLabel: string;
  readonly pendingElicitations: readonly SessionElicitationRequestedEvent[];
  readonly pendingPermissions: readonly SessionPermissionRequestedEvent[];
  readonly nativeHistory: NativeSessionHistory | null;
  readonly status: "active" | "deleted";
  readonly restored: boolean;
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly usage: readonly SessionUsageUpdatedEvent[];

  constructor(
    ready: SessionReadyEvent,
    configOptions: readonly SessionConfigOption[] = ready.configOptions,
    commands: SessionCommandsUpdatedEvent["commands"] = [],
    title = "",
    updatedAt = "",
    usage: readonly SessionUsageUpdatedEvent[] = [],
    pendingPermissions: readonly SessionPermissionRequestedEvent[] = [],
    pendingElicitations: readonly SessionElicitationRequestedEvent[] = [],
    nativeHistory: NativeSessionHistory | null = null,
    status: "active" | "deleted" = "active",
  ) {
    this.status = status;
    this.nativeHistory = nativeHistory;
    this.additionalDirectories = ready.additionalDirectories;
    this.agentId = ready.agentId;
    this.agentName = ready.agentName;
    this.agentVersion = ready.agentVersion;
    this.capabilities = ready.capabilities;
    this.commands = commands;
    this.configOptions = configOptions;
    this.directoryId = ready.directoryId;
    this.directoryLabel = ready.directoryLabel;
    this.pendingElicitations = pendingElicitations;
    this.pendingPermissions = pendingPermissions;
    this.restored = ready.restored;
    this.sessionId = ready.sessionId;
    this.title = title;
    this.updatedAt = updatedAt;
    this.usage = usage;
  }

  readonly withDeleted = (): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      this.usage,
      [],
      [],
      this.nativeHistory,
      "deleted",
    );

  readonly readyEvent = (): SessionReadyEvent => ({
    additionalDirectories: this.additionalDirectories,
    agentId: this.agentId,
    agentName: this.agentName,
    agentVersion: this.agentVersion,
    capabilities: this.capabilities,
    commands: this.commands,
    configOptions: this.configOptions,
    directoryId: this.directoryId,
    directoryLabel: this.directoryLabel,
    kind: "session.ready",
    protocolVersion: MOBIUS_PROTOCOL_VERSION,
    requestId: "history-snapshot",
    restored: this.restored,
    sessionId: this.sessionId,
  });

  readonly withConfig = (
    configOptions: readonly SessionConfigOption[],
  ): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      this.usage,
      this.pendingPermissions,
      this.pendingElicitations,
      this.nativeHistory,
      this.status,
    );

  readonly withCommands = (
    commands: SessionCommandsUpdatedEvent["commands"],
  ): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      commands,
      this.title,
      this.updatedAt,
      this.usage,
      this.pendingPermissions,
      this.pendingElicitations,
      this.nativeHistory,
      this.status,
    );

  readonly withInfo = (
    title: string | null,
    updatedAt: string,
  ): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      title ?? this.title,
      updatedAt,
      this.usage,
      this.pendingPermissions,
      this.pendingElicitations,
      this.nativeHistory,
      this.status,
    );

  readonly withUsage = (usage: SessionUsageUpdatedEvent): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      [...this.usage.filter((entry) => entry.source !== usage.source), usage],
      this.pendingPermissions,
      this.pendingElicitations,
      this.nativeHistory,
      this.status,
    );

  readonly withPermission = (
    permission: SessionPermissionRequestedEvent,
  ): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      this.usage,
      [
        ...this.pendingPermissions.filter(
          (entry) => entry.interactionId !== permission.interactionId,
        ),
        permission,
      ],
      this.pendingElicitations,
      this.nativeHistory,
      this.status,
    );

  readonly withoutPermission = (interactionId: string): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      this.usage,
      this.pendingPermissions.filter(
        (entry) => entry.interactionId !== interactionId,
      ),
      this.pendingElicitations,
      this.nativeHistory,
      this.status,
    );

  readonly withElicitation = (
    elicitation: SessionElicitationRequestedEvent,
  ): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      this.usage,
      this.pendingPermissions,
      [
        ...this.pendingElicitations.filter(
          (entry) => entry.interactionId !== elicitation.interactionId,
        ),
        elicitation,
      ],
      this.nativeHistory,
      this.status,
    );

  readonly withoutElicitation = (interactionId: string): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      this.usage,
      this.pendingPermissions,
      this.pendingElicitations.filter(
        (entry) => entry.interactionId !== interactionId,
      ),
      this.nativeHistory,
      this.status,
    );

  readonly withoutInteractionsForCommands = (
    commandIds: ReadonlySet<string>,
  ): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      this.title,
      this.updatedAt,
      this.usage,
      this.pendingPermissions.filter(
        (entry) => !commandIds.has(entry.commandId),
      ),
      this.pendingElicitations.filter(
        (entry) => !commandIds.has(entry.commandId),
      ),
      this.nativeHistory,
      this.status,
    );

  readonly resolveElicitation = (
    event: SessionElicitationResolvedEvent,
  ): RecordedSession => {
    const elicitation = this.pendingElicitations.find(
      (entry) => entry.interactionId === event.interactionId,
    );
    if (
      event.action !== "accept" ||
      elicitation === undefined ||
      elicitation.mode !== "url"
    ) {
      return this.withoutElicitation(event.interactionId);
    }
    return this.withElicitation({ ...elicitation, accepted: true });
  };
}

export interface ChannelSessionStore {
  readonly removeSessions: (sessionIds: readonly string[]) => void;
  readonly clearInteractionsForCommands: (
    commandIds: readonly string[],
  ) => void;
  readonly readSessions: () => readonly RecordedSession[];
  readonly recordCommands: (event: SessionCommandsUpdatedEvent) => void;
  readonly recordConfig: (event: SessionConfigUpdatedEvent) => void;
  readonly recordElicitation: (event: SessionElicitationRequestedEvent) => void;
  readonly recordInfo: (event: SessionInfoUpdatedEvent) => void;
  readonly recordPermission: (event: SessionPermissionRequestedEvent) => void;
  readonly recordReady: (
    event: SessionReadyEvent,
    history?: NativeSessionHistory,
  ) => void;
  readonly recordUsage: (event: SessionUsageUpdatedEvent) => void;
  readonly resolveElicitation: (event: SessionElicitationResolvedEvent) => void;
  readonly resolvePermission: (event: SessionPermissionResolvedEvent) => void;
}

export class MemoryChannelSessionStore implements ChannelSessionStore {
  readonly #sessions = new Map<string, RecordedSession>();
  readonly removeSessions = (sessionIds: readonly string[]): void => {
    for (const id of sessionIds) {
      const session = this.#sessions.get(id);
      if (session !== undefined) this.#sessions.set(id, session.withDeleted());
    }
  };

  readonly clearInteractionsForCommands = (
    commandIds: readonly string[],
  ): void => {
    const commandIdSet = new Set(commandIds);
    for (const [sessionId, session] of this.#sessions) {
      this.#sessions.set(
        sessionId,
        session.withoutInteractionsForCommands(commandIdSet),
      );
    }
  };

  readonly readSessions = (): readonly RecordedSession[] =>
    [...this.#sessions.values()].sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );

  readonly recordReady = (
    event: SessionReadyEvent,
    history?: NativeSessionHistory,
  ): void => {
    const previous = this.#sessions.get(event.sessionId);
    this.#sessions.set(
      event.sessionId,
      new RecordedSession(
        event,
        event.configOptions,
        event.commands.length > 0 ? event.commands : (previous?.commands ?? []),
        previous?.title ?? "",
        previous?.updatedAt ?? "",
        previous?.usage ?? [],
        previous?.pendingPermissions ?? [],
        previous?.pendingElicitations ?? [],
        history ?? previous?.nativeHistory ?? null,
        previous?.status ?? "active",
      ),
    );
  };

  readonly recordConfig = (event: SessionConfigUpdatedEvent): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(
        event.sessionId,
        session.withConfig(event.configOptions),
      );
    }
  };

  readonly recordCommands = (event: SessionCommandsUpdatedEvent): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(event.sessionId, session.withCommands(event.commands));
    }
  };

  readonly recordInfo = (event: SessionInfoUpdatedEvent): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(
        event.sessionId,
        session.withInfo(event.title, event.updatedAt),
      );
    }
  };

  readonly recordUsage = (event: SessionUsageUpdatedEvent): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(event.sessionId, session.withUsage(event));
    }
  };

  readonly recordPermission = (
    event: SessionPermissionRequestedEvent,
  ): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(event.sessionId, session.withPermission(event));
    }
  };

  readonly resolvePermission = (
    event: SessionPermissionResolvedEvent,
  ): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(
        event.sessionId,
        session.withoutPermission(event.interactionId),
      );
    }
  };

  readonly recordElicitation = (
    event: SessionElicitationRequestedEvent,
  ): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(event.sessionId, session.withElicitation(event));
    }
  };

  readonly resolveElicitation = (
    event: SessionElicitationResolvedEvent,
  ): void => {
    const session = this.#sessions.get(event.sessionId);
    if (session !== undefined) {
      this.#sessions.set(event.sessionId, session.resolveElicitation(event));
    }
  };
}
