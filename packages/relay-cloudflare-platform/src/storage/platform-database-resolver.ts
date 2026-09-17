import { PairingDirectoryError, type ProjectDatabaseBindings } from "@moxt-ai/mobius-relay-core/contracts";
import type { SqlDatabase } from "@moxt-ai/mobius-relay-core/database";
import type {
    PlatformProjectLocationHint,
    PlatformProjectPlacement,
    PlatformProjectPlacementRegistry,
} from "../entity/platform-control-plane.ts";
import { decodePlatformProjectPlacement, projectBucketLocation } from "../entity/platform-project-id.ts";
import { ProjectDurableObjectDatabase } from "./project-durable-object-database.ts";

export interface PlatformStorageBindings {
    readonly PROJECT_RELAY: DurableObjectNamespace;
    readonly R2_BUCKET_WNAM?: R2Bucket;
    readonly R2_BUCKET_APAC?: R2Bucket;
}

interface PlatformProjectDatabaseResult<Row = unknown> {
    readonly results: readonly Row[];
    readonly success: true;
    readonly meta: { readonly changes: number };
}

export interface PlatformProjectPreparedStatement {
    readonly bind: (...values: readonly unknown[]) => PlatformProjectPreparedStatement;
    readonly first: <Row = Record<string, unknown>>() => Promise<Row | null>;
    readonly all: <Row = Record<string, unknown>>() => Promise<PlatformProjectDatabaseResult<Row>>;
    readonly run: () => Promise<PlatformProjectDatabaseResult>;
}

export interface PlatformProjectDatabase {
    readonly prepare: (sql: string) => PlatformProjectPreparedStatement;
    readonly batch: (
        statements: readonly PlatformProjectPreparedStatement[],
    ) => Promise<readonly PlatformProjectDatabaseResult[]>;
}

class ProjectStatementAdapter implements PlatformProjectPreparedStatement {
    readonly owner: ProjectDatabaseAdapter;
    readonly statement: ReturnType<SqlDatabase["prepare"]>;

    constructor(owner: ProjectDatabaseAdapter, statement: ReturnType<SqlDatabase["prepare"]>) {
        this.owner = owner;
        this.statement = statement;
    }

    readonly bind: PlatformProjectPreparedStatement["bind"] = (...values) =>
        new ProjectStatementAdapter(this.owner, this.statement.bind(...values));

    readonly first: PlatformProjectPreparedStatement["first"] = async <Row>() =>
        await this.statement.first<Row>(AbortSignal.timeout(15_000));

    readonly all: PlatformProjectPreparedStatement["all"] = async <Row>() => {
        const result = await this.statement.all<Row>(AbortSignal.timeout(15_000));
        return { ...result, success: true };
    };

    readonly run: PlatformProjectPreparedStatement["run"] = async () => {
        const result = await this.statement.run(AbortSignal.timeout(15_000));
        return { ...result, success: true };
    };
}

class ProjectDatabaseAdapter implements PlatformProjectDatabase {
    readonly database: SqlDatabase;

    constructor(database: SqlDatabase) {
        this.database = database;
    }

    readonly prepare: PlatformProjectDatabase["prepare"] = (sql) =>
        new ProjectStatementAdapter(this, this.database.prepare(sql));

    readonly batch: PlatformProjectDatabase["batch"] = async (statements) => {
        const prepared = [];
        for (const statement of statements) {
            if (!(statement instanceof ProjectStatementAdapter) || statement.owner !== this) {
                throw new Error("SQL statements must belong to one Project database");
            }
            prepared.push(statement.statement);
        }
        return (await this.database.batch(prepared, AbortSignal.timeout(15_000))).map((result) => ({
            ...result,
            success: true,
        }));
    };
}

const locationHints: ReadonlySet<string> = new Set([
    "wnam",
    "enam",
    "sam",
    "weur",
    "eeur",
    "apac",
    "apac-ne",
    "apac-se",
    "oc",
    "afr",
    "me",
]);

function isPlatformProjectLocationHint(value: string): value is PlatformProjectLocationHint {
    return locationHints.has(value);
}

export function platformBucket(bindings: PlatformStorageBindings, id: string): R2Bucket | undefined {
    return id === "apac" ? bindings.R2_BUCKET_APAC : id === "wnam" ? bindings.R2_BUCKET_WNAM : undefined;
}

export class PlatformStorageRegistry implements PlatformProjectPlacementRegistry {
    readonly #bindings: PlatformStorageBindings;

    constructor(bindings: PlatformStorageBindings) {
        this.#bindings = bindings;
    }

    readonly supports = (placement: PlatformProjectPlacement): boolean =>
        platformBucket(this.#bindings, projectBucketLocation(placement.locationHint)) !== undefined;

    readonly resolveLocationHint = (locationHint: string): PlatformProjectPlacement | null =>
        isPlatformProjectLocationHint(locationHint) &&
        platformBucket(this.#bindings, projectBucketLocation(locationHint)) !== undefined
            ? { locationHint }
            : null;
}

export class PlatformDatabaseResolver implements ProjectDatabaseBindings {
    readonly #projects: DurableObjectNamespace;
    readonly #local: { readonly projectId: string; readonly database: SqlDatabase } | null;

    constructor(
        bindings: PlatformStorageBindings,
        local: { readonly projectId: string; readonly database: SqlDatabase } | null = null,
    ) {
        this.#projects = bindings.PROJECT_RELAY;
        this.#local = local;
    }

    readonly resolve: ProjectDatabaseBindings["resolve"] = (sharding) => {
        if (!sharding.hasShard) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        const projectId = sharding.shard.d1ShardId;
        if (this.#local?.projectId === projectId) {
            return this.#local.database;
        }
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return new ProjectDurableObjectDatabase(this.#projects, projectId, placement.locationHint);
    };

    readonly project = (projectId: string): PlatformProjectDatabase => {
        const placement = decodePlatformProjectPlacement(projectId);
        if (placement === null) {
            throw new PairingDirectoryError("directory_unavailable", "Project storage is unavailable");
        }
        return new ProjectDatabaseAdapter(
            this.resolve({
                hasShard: true,
                shard: { d1ShardId: projectId, r2BucketId: projectBucketLocation(placement.locationHint), revision: 1 },
            }),
        );
    };
}

export function projectDatabase(databases: PlatformDatabaseResolver, projectId: string): PlatformProjectDatabase {
    return databases.project(projectId);
}
