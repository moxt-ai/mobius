interface MigrationDatabase {
    readonly prepare: (query: string) => {
        readonly run: () => Promise<unknown>;
    };
}

interface MigrationWorkerEnv {
    readonly DIRECTORY_DATABASE: MigrationDatabase;
    readonly MIGRATION_TOKEN: string;
}

interface MigrationPayload {
    readonly queries: readonly string[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeMigrationPayload(value: unknown): MigrationPayload | null {
    if (!isRecord(value)) {
        return null;
    }
    const queries = value["queries"];
    if (
        !Array.isArray(queries) ||
        queries.length === 0 ||
        queries.length > 1_000 ||
        !queries.every((query) => typeof query === "string" && query.length > 0 && query.length <= 1_000_000)
    ) {
        return null;
    }
    return { queries };
}

const migrationWorker = {
    fetch: async (request: Request, env: MigrationWorkerEnv): Promise<Response> => {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/apply") {
            return new Response("Not found", { status: 404 });
        }
        if (request.headers.get("authorization") !== `Bearer ${env.MIGRATION_TOKEN}`) {
            return new Response("Unauthorized", { status: 401 });
        }

        let value: unknown;
        try {
            value = await request.json();
        } catch {
            return new Response("Invalid migration payload", { status: 400 });
        }
        const payload = decodeMigrationPayload(value);
        if (payload === null) {
            return new Response("Invalid migration payload", { status: 400 });
        }

        for (const query of payload.queries) {
            await env.DIRECTORY_DATABASE.prepare(query).run();
        }
        return new Response(null, { status: 204 });
    },
};

export default migrationWorker;
