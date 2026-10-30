import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { relayDrizzle } from "../../relay-core/src/infra/drizzle-database.ts";
import { DurableObjectDatabaseAdapter } from "../../relay-core/src/infra/durable-object-sql-database.ts";
import { runtimeIdentity, runtimeRegistration } from "../../relay-core/src/schema/project-do/index.ts";
import { platformApp, platformProject } from "../src/schema/d1/index.ts";
import { platformDrizzle } from "../src/storage/platform-drizzle-database.ts";

/** Internal Runtime DO scenarios enter after public pairing has registered the Runtime in an active Project. */
export async function registerRuntimeFixture(projectId: string, runtimeId: string): Promise<void> {
    const registeredAt = Date.UTC(2026, 9, 27);
    const appId = `app_${projectId}`;
    const directory = platformDrizzle(env.PLATFORM_DIRECTORY_DATABASE);
    await directory.batch([
        directory
            .insert(platformApp)
            .values({
                appId,
                tenantId: `tenant_${projectId}`,
                displayName: "Recording test App",
                lifecycle: "active",
                createdAt: registeredAt,
                updatedAt: registeredAt,
            })
            .onConflictDoNothing(),
        directory
            .insert(platformProject)
            .values({
                projectId,
                appId,
                displayName: "Recording test Project",
                clientReference: projectId,
                idempotencyKey: projectId,
                requestDigest: projectId,
                lifecycle: "active",
                createdAt: registeredAt,
                updatedAt: registeredAt,
            })
            .onConflictDoNothing(),
    ]);
    await runInDurableObject(env.PROJECT_RELAY.getByName(projectId), async (_instance, state) => {
        const database = relayDrizzle(new DurableObjectDatabaseAdapter(state.storage), AbortSignal.timeout(10_000));
        await database.batch([
            database
                .insert(runtimeIdentity)
                .values({ runtimeId, projectId, channelId: runtimeId, createdAt: registeredAt })
                .onConflictDoNothing(),
            database
                .insert(runtimeRegistration)
                .values({
                    runtimeId,
                    claimedAt: registeredAt,
                    machineName: "Recording test Runtime",
                    workspaceName: "Recording test workspace",
                    agentsJson: "[]",
                })
                .onConflictDoNothing(),
        ]);
    });
}
