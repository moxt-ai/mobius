import { messageIdMigrationRequestSchema } from "./entity/message-id-migration.ts";
import { authorizeMessageIdMigration } from "./infra/authorize-message-id-migration.ts";
import type { RecordingWorkerBindings } from "./worker.ts";

export interface MessageIdMigrationWorkerBindings extends Pick<RecordingWorkerBindings, "SESSION_RECORDING"> {
    readonly MIGRATION_TOKEN: string;
}

export function createMessageIdMigrationWorker() {
    return {
        fetch: async (request: Request, environment: MessageIdMigrationWorkerBindings): Promise<Response> => {
            const denied = await authorizeMessageIdMigration(request, environment.MIGRATION_TOKEN);
            if (denied !== null) {
                return denied;
            }
            const match = /^\/sessions\/([a-f0-9]{64})$/.exec(new URL(request.url).pathname);
            const objectId = match?.[1];
            if (request.method !== "POST" || objectId === undefined) {
                return Response.json({ error: { code: "invalid_migration_target" } }, { status: 400 });
            }
            let input: unknown;
            try {
                input = await request.json();
            } catch {
                return Response.json({ error: { code: "invalid_migration_request" } }, { status: 400 });
            }
            const parsed = messageIdMigrationRequestSchema.safeParse(input);
            if (!parsed.success) {
                return Response.json({ error: { code: "invalid_migration_request" } }, { status: 400 });
            }
            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
            try {
                const id = environment.SESSION_RECORDING.idFromString(objectId);
                return await environment.SESSION_RECORDING.get(id).fetch(
                    "https://recording.internal/migrations/message-ids",
                    {
                        method: "POST",
                        headers: {
                            authorization: `Bearer ${environment.MIGRATION_TOKEN}`,
                            "content-type": "application/json",
                        },
                        body: JSON.stringify(parsed.data),
                        signal,
                    },
                );
            } catch {
                request.signal.throwIfAborted();
                return Response.json(
                    { error: { code: signal.aborted ? "migration_timeout" : "migration_unavailable" } },
                    { status: 503 },
                );
            }
        },
    };
}

export default createMessageIdMigrationWorker();
