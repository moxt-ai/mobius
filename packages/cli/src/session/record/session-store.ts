import { z } from "zod";
import type { AcpSessionRow, AcpSessionTable } from "../../storage/session/acp-session-table.ts";
import { type AcpSessionEventStore, MemoryAcpSessionEventStore } from "../history/session-event-store.ts";
import {
    type AcpStoredSessionConfiguration,
    decodeStoredSessionConfigurations,
} from "../live/session-configurations.ts";

export class AcpStoredSession {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
    readonly configurations: readonly AcpStoredSessionConfiguration[];
    readonly cwd: string;
    readonly nativeSessionId: string;
    readonly prompted: boolean;
    readonly sessionId: string;
    readonly title: string;
    readonly updatedAt: string;

    constructor(
        sessionId: string,
        agentId: string,
        nativeSessionId: string,
        cwd: string,
        additionalDirectories: readonly string[],
        prompted: boolean,
        title: string,
        updatedAt = new Date().toISOString(),
        configurations: readonly AcpStoredSessionConfiguration[] = [],
    ) {
        this.additionalDirectories = [...additionalDirectories];
        this.agentId = agentId;
        this.cwd = cwd;
        this.configurations = configurations.map((configuration) => ({ ...configuration }));
        this.nativeSessionId = nativeSessionId;
        this.prompted = prompted;
        this.sessionId = sessionId;
        this.title = title;
        this.updatedAt = updatedAt;
    }
}

export abstract class AcpStoredSessionLookup {
    abstract readonly found: boolean;
}

export class MissingAcpStoredSession extends AcpStoredSessionLookup {
    readonly found = false;
}

export class FoundAcpStoredSession extends AcpStoredSessionLookup {
    readonly found = true;
    readonly session: AcpStoredSession;

    constructor(session: AcpStoredSession) {
        super();
        this.session = session;
    }
}

export interface AcpSessionStore {
    readonly close: () => void;
    readonly events: AcpSessionEventStore;
    readonly findNative: (agentId: string, nativeSessionId: string) => readonly AcpStoredSession[];
    readonly list: () => readonly AcpStoredSession[];
    readonly read: (sessionId: string) => AcpStoredSessionLookup;
    readonly remove: (sessionId: string) => void;
    readonly write: (session: AcpStoredSession) => void;
}

export class MemoryAcpSessionStore implements AcpSessionStore {
    readonly events: AcpSessionEventStore;
    readonly #sessions = new Map<string, AcpStoredSession>();

    constructor(events: AcpSessionEventStore = new MemoryAcpSessionEventStore()) {
        this.events = events;
    }

    readonly close = (): void => {
        this.#sessions.clear();
        this.events.close();
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpStoredSession[] =>
        [...this.#sessions.values()].filter(
            (session) => session.agentId === agentId && session.nativeSessionId === nativeSessionId,
        );

    readonly list = (): readonly AcpStoredSession[] =>
        [...this.#sessions.values()].toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    readonly read = (sessionId: string): AcpStoredSessionLookup => {
        const session = this.#sessions.get(sessionId);
        return session === undefined ? new MissingAcpStoredSession() : new FoundAcpStoredSession(session);
    };

    readonly remove = (sessionId: string): void => {
        this.#sessions.delete(sessionId);
        this.events.remove(sessionId);
    };

    readonly write = (session: AcpStoredSession): void => {
        this.#sessions.set(session.sessionId, session);
    };
}

function decodeStoredSession(row: AcpSessionRow): AcpStoredSession {
    const decodedAdditionalDirectories: unknown = JSON.parse(row.additionalDirectories);
    const additionalDirectories = z.array(z.string()).parse(decodedAdditionalDirectories);
    const decodedConfigurations: unknown = JSON.parse(row.configurations);
    const configurations = decodeStoredSessionConfigurations(decodedConfigurations);
    return new AcpStoredSession(
        row.sessionId,
        row.agentId,
        row.nativeSessionId,
        row.cwd,
        additionalDirectories,
        row.prompted,
        row.title,
        row.updatedAt,
        configurations,
    );
}

export class SqliteAcpSessionStore implements AcpSessionStore {
    readonly events: AcpSessionEventStore;
    readonly #table: AcpSessionTable;

    constructor(table: AcpSessionTable, events: AcpSessionEventStore = new MemoryAcpSessionEventStore()) {
        this.events = events;
        this.#table = table;
    }

    readonly close = (): void => {
        try {
            this.#table.close();
        } finally {
            this.events.close();
        }
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpStoredSession[] =>
        this.#table.findNative(agentId, nativeSessionId).map(decodeStoredSession);

    readonly list = (): readonly AcpStoredSession[] => this.#table.list().map(decodeStoredSession);

    readonly read = (sessionId: string): AcpStoredSessionLookup => {
        const row = this.#table.read(sessionId);
        return row === undefined ? new MissingAcpStoredSession() : new FoundAcpStoredSession(decodeStoredSession(row));
    };

    readonly remove = (sessionId: string): void => {
        this.#table.remove(sessionId);
        this.events.remove(sessionId);
    };

    readonly write = (session: AcpStoredSession): void => {
        this.#table.upsert({
            additionalDirectories: JSON.stringify(session.additionalDirectories),
            agentId: session.agentId,
            configurations: JSON.stringify(session.configurations),
            cwd: session.cwd,
            nativeSessionId: session.nativeSessionId,
            prompted: session.prompted,
            sessionId: session.sessionId,
            title: session.title,
            updatedAt: session.updatedAt,
        });
    };
}
