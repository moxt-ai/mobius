import {
  MOBIUS_PROTOCOL_VERSION,
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
  ) {
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
    );

  readonly withInfo = (title: string, updatedAt: string): RecordedSession =>
    new RecordedSession(
      this.readyEvent(),
      this.configOptions,
      this.commands,
      title,
      updatedAt,
      this.usage,
      this.pendingPermissions,
      this.pendingElicitations,
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
  readonly clearInteractionsForCommands: (
    commandIds: readonly string[],
  ) => void;
  readonly readSessions: () => readonly RecordedSession[];
  readonly recordCommands: (event: SessionCommandsUpdatedEvent) => void;
  readonly recordConfig: (event: SessionConfigUpdatedEvent) => void;
  readonly recordElicitation: (event: SessionElicitationRequestedEvent) => void;
  readonly recordInfo: (event: SessionInfoUpdatedEvent) => void;
  readonly recordPermission: (event: SessionPermissionRequestedEvent) => void;
  readonly recordReady: (event: SessionReadyEvent) => void;
  readonly recordUsage: (event: SessionUsageUpdatedEvent) => void;
  readonly resolveElicitation: (event: SessionElicitationResolvedEvent) => void;
  readonly resolvePermission: (event: SessionPermissionResolvedEvent) => void;
}

export class MemoryChannelSessionStore implements ChannelSessionStore {
  readonly #sessions = new Map<string, RecordedSession>();

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

  readonly recordReady = (event: SessionReadyEvent): void => {
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
