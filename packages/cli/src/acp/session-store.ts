import { and, desc, eq } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { z } from "zod";
import type { LocalSqliteDatabase } from "../infra/local-sqlite-database.ts";
import { acpSession } from "../schema/acp-session-store/index.ts";
import { type AcpStoredSessionConfiguration, decodeStoredSessionConfigurations } from "./session-configuration.ts";
import { type AcpSessionEventStore, MemoryAcpSessionEventStore } from "./session-event-store.ts";

export class AcpStoredSession {
    readonly additionalDirectories: readonly string[];
    readonly agentId: string;
    readonly cwd: string;
    readonly configurations: readonly AcpStoredSessionConfiguration[];
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

const storedSessionRowSchema = z.object({
    additionalDirectories: z.string(),
    agentId: z.string(),
    configurations: z.string(),
    cwd: z.string(),
    nativeSessionId: z.string(),
    prompted: z.boolean(),
    sessionId: z.string(),
    title: z.string(),
    updatedAt: z.string(),
});

function decodeStoredSession(value: unknown): AcpStoredSession {
    const row = storedSessionRowSchema.parse(value);
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
    readonly #database: NodeSQLiteDatabase;
    readonly #localDatabase: LocalSqliteDatabase;

    constructor(localDatabase: LocalSqliteDatabase, events: AcpSessionEventStore = new MemoryAcpSessionEventStore()) {
        this.events = events;
        this.#localDatabase = localDatabase;
        this.#database = localDatabase.orm;
    }

    readonly close = (): void => {
        try {
            this.#localDatabase.close();
        } finally {
            this.events.close();
        }
    };

    readonly findNative = (agentId: string, nativeSessionId: string): readonly AcpStoredSession[] =>
        this.#database
            .select()
            .from(acpSession)
            .where(and(eq(acpSession.agentId, agentId), eq(acpSession.nativeSessionId, nativeSessionId)))
            .all()
            .map(decodeStoredSession);

    readonly list = (): readonly AcpStoredSession[] =>
        this.#database.select().from(acpSession).orderBy(desc(acpSession.updatedAt)).all().map(decodeStoredSession);

    readonly read = (sessionId: string): AcpStoredSessionLookup => {
        const row = this.#database.select().from(acpSession).where(eq(acpSession.sessionId, sessionId)).get();
        return row === undefined ? new MissingAcpStoredSession() : new FoundAcpStoredSession(decodeStoredSession(row));
    };

    readonly remove = (sessionId: string): void => {
        this.#database.delete(acpSession).where(eq(acpSession.sessionId, sessionId)).run();
        this.events.remove(sessionId);
    };

    readonly write = (session: AcpStoredSession): void => {
        const value = {
            additionalDirectories: JSON.stringify(session.additionalDirectories),
            agentId: session.agentId,
            configurations: JSON.stringify(session.configurations),
            cwd: session.cwd,
            nativeSessionId: session.nativeSessionId,
            prompted: session.prompted,
            sessionId: session.sessionId,
            title: session.title,
            updatedAt: session.updatedAt,
        };
        this.#database
            .insert(acpSession)
            .values(value)
            .onConflictDoUpdate({ target: acpSession.sessionId, set: value })
            .run();
    };
}
