interface Env {
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly PROJECT_RELAY: DurableObjectNamespace;
    readonly HELPER_TOKEN: string;
}

function json(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function migrationPath(projectId: string): string {
    return `/mobius/internal/projects/${encodeURIComponent(projectId)}/migrations/cloud-retention`;
}

interface MigrationResult {
    readonly state: "in_progress" | "complete";
    readonly migratedSessions: number;
    readonly nextAfterSessionId?: string;
    readonly sessionCount?: number;
}

/** Migrate one Project Durable Object by paging its Session directory. */
async function migrateProject(
    env: Env,
    projectId: string,
): Promise<{ migratedSessions: number; sessionCount: number }> {
    let afterSessionId = "";
    let migratedSessions = 0;
    for (;;) {
        const response = await env.PROJECT_RELAY.getByName(projectId).fetch(
            `https://project.internal${migrationPath(projectId)}`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ afterSessionId }),
            },
        );
        if (!response.ok) {
            throw new Error(`Project ${projectId} rejected the migration with ${response.status}`);
        }
        const body = (await response.json()) as MigrationResult;
        migratedSessions += body.migratedSessions;
        if (body.state === "complete") {
            return { migratedSessions, sessionCount: body.sessionCount ?? 0 };
        }
        afterSessionId = body.nextAfterSessionId ?? "";
        if (afterSessionId === "") {
            throw new Error(`Project ${projectId} returned an empty continuation cursor`);
        }
    }
}

/** Projects that have no completion record yet. */
async function remainingProjectIds(env: Env): Promise<readonly string[]> {
    const rows = await env.PLATFORM_DIRECTORY_DATABASE.prepare(
        `SELECT project_id FROM platform_projects
          WHERE project_id NOT IN (SELECT project_id FROM platform_cloud_retention_migrations)
          ORDER BY project_id`,
    ).all();
    return rows.results.map((row) => row["project_id"] as string);
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.headers.get("x-helper-token") !== env.HELPER_TOKEN) {
            return json({ error: "unauthorized" }, 401);
        }
        const url = new URL(request.url);

        if (url.pathname === "/status") {
            const total = await env.PLATFORM_DIRECTORY_DATABASE.prepare(
                "SELECT COUNT(*) AS value FROM platform_projects",
            ).first<{ value: number }>();
            const completed = await env.PLATFORM_DIRECTORY_DATABASE.prepare(
                "SELECT COUNT(*) AS value FROM platform_cloud_retention_migrations",
            ).first<{ value: number }>();
            return json({
                totalProjects: total?.value ?? 0,
                completedProjects: completed?.value ?? 0,
                remainingProjects: (await remainingProjectIds(env)).length,
            });
        }

        if (url.pathname === "/migrate-batch" && request.method === "POST") {
            const requested = Number(url.searchParams.get("limit") ?? "10");
            const limit = Number.isSafeInteger(requested) && requested > 0 ? requested : 10;
            const batch = (await remainingProjectIds(env)).slice(0, limit);
            let migratedProjects = 0;
            let migratedSessions = 0;
            for (const projectId of batch) {
                const result = await migrateProject(env, projectId);
                await env.PLATFORM_DIRECTORY_DATABASE.prepare(
                    `INSERT INTO platform_cloud_retention_migrations (project_id, session_count, completed_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(project_id) DO UPDATE SET session_count = excluded.session_count`,
                )
                    .bind(projectId, result.sessionCount, Date.now())
                    .run();
                migratedProjects += 1;
                migratedSessions += result.migratedSessions;
            }
            return json({
                migratedProjects,
                migratedSessions,
                remainingProjects: (await remainingProjectIds(env)).length,
            });
        }

        return json({ error: "not found" }, 404);
    },
};
