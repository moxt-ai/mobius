import { applyDurableObjectMigrations, DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import { nonCloudRetentionSessionRelayDurableObjectMigrations } from "../generated/non-cloud-retention-session-relay-do-migrations.ts";

const NOT_ENABLED_CODE = "non_cloud_retention_session_relay_not_enabled";

export class NonCloudRetentionSessionRelayDO {
    constructor(state: DurableObjectState) {
        applyDurableObjectMigrations(
            new DurableObjectSqlDatabase(state.storage),
            "non-cloud-retention-session-relay-do",
            nonCloudRetentionSessionRelayDurableObjectMigrations,
        );
    }

    readonly fetch = (): Response =>
        Response.json(
            {
                code: NOT_ENABLED_CODE,
                message: "Non-cloud-retention Session routing is not enabled",
            },
            { status: 503 },
        );
}
