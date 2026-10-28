import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { relayDrizzle } from "../../relay-core/src/infra/drizzle-database.ts";
import { DurableObjectDatabaseAdapter } from "../../relay-core/src/infra/durable-object-sql-database.ts";
import { runtimeIdentity, runtimeRegistration } from "../../relay-core/src/schema/project-do/index.ts";

/** Internal Runtime DO scenarios enter after public pairing has registered the Runtime. */
export async function registerRuntimeFixture(projectId: string, runtimeId: string): Promise<void> {
    await runInDurableObject(env.PROJECT_RELAY.getByName(projectId), async (_instance, state) => {
        const database = relayDrizzle(new DurableObjectDatabaseAdapter(state.storage), AbortSignal.timeout(10_000));
        await database.batch([
            database
                .insert(runtimeIdentity)
                .values({ runtimeId, projectId, channelId: runtimeId, createdAt: Date.UTC(2026, 9, 27) })
                .onConflictDoNothing(),
            database
                .insert(runtimeRegistration)
                .values({
                    runtimeId,
                    claimedAt: Date.UTC(2026, 9, 27),
                    machineName: "Recording test Runtime",
                    workspaceName: "Recording test workspace",
                    agentsJson: "[]",
                })
                .onConflictDoNothing(),
        ]);
    });
}
