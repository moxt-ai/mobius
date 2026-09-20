import { DurableObjectSqlDatabase, SessionRelay as SessionRelayImplementation } from "@moxt-ai/mobius-relay-core";
import { PlatformBucketResolver } from "../storage/platform-bucket-resolver.ts";
import {
    createPlatformDurableObjectContext,
    type PlatformDurableObjectEnvironment,
} from "./platform-durable-object-context.ts";

export class PlatformSessionRelay extends SessionRelayImplementation {
    constructor(state: DurableObjectState, environment: PlatformDurableObjectEnvironment) {
        super(
            createPlatformDurableObjectContext(state, environment, {
                database: new DurableObjectSqlDatabase(state.storage),
                content: { kind: "r2", buckets: new PlatformBucketResolver(environment) },
            }),
        );
    }
}
