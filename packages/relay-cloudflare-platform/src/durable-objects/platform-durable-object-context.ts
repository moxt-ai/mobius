import { createDurableObjectContext, type DurableObjectSqlDatabase } from "@moxt-ai/mobius-relay-core";
import { PlatformSessionRecording, platformRecordingProvider } from "../gateway/platform-session-recording.ts";
import { PlatformSessionStatusNotifications } from "../gateway/platform-session-status-notifications.ts";
import { ProjectDurableObjectStores } from "../gateway/project-durable-object-store.ts";
import { PlatformProjectStorageDirectory } from "../infra/platform-project-storage-directory.ts";
import { AppSessionStatusWebhookService } from "../service/app-session-status-webhook-service.ts";
import { AppSessionStatusWebhookStorage } from "../storage/app-session-status-webhook-storage.ts";
import { PlatformControlPlaneStorage } from "../storage/platform-control-plane-storage.ts";
import { type PlatformStorageBindings, PlatformStorageRegistry } from "../storage/platform-storage-registry.ts";
import { RecordingPolicyStorage } from "../storage/recording-policy-storage.ts";
import type { ProjectDO } from "./project-do.ts";

export interface PlatformDurableObjectEnvironment extends PlatformStorageBindings {
    readonly PLATFORM_DIRECTORY_DATABASE: D1Database;
    readonly MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY?: string;
    readonly RECORDING?: Fetcher;
    readonly RECORDING_PROVIDER_ID?: string;
    readonly PROJECT_RELAY: DurableObjectNamespace<ProjectDO>;
    readonly RUNTIME_RELAY: DurableObjectNamespace;
}

export function createPlatformDurableObjectContext(
    state: DurableObjectState,
    environment: PlatformDurableObjectEnvironment,
    storage: { readonly database: DurableObjectSqlDatabase },
) {
    const stores = new ProjectDurableObjectStores(environment.PROJECT_RELAY);
    const registry = new PlatformStorageRegistry(environment);
    const projects = new PlatformProjectStorageDirectory(
        registry,
        new PlatformControlPlaneStorage(environment.PLATFORM_DIRECTORY_DATABASE, stores),
    );
    const webhookStorage = new AppSessionStatusWebhookStorage(environment.PLATFORM_DIRECTORY_DATABASE);
    const webhookService = new AppSessionStatusWebhookService(
        null,
        webhookStorage,
        environment.MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY,
    );
    return createDurableObjectContext(state, {
        stores,
        projects,
        doDatabase: storage.database,
        recording: new PlatformSessionRecording(
            new RecordingPolicyStorage(environment.PLATFORM_DIRECTORY_DATABASE),
            platformRecordingProvider(environment),
        ),
        notifications: new PlatformSessionStatusNotifications(webhookStorage, webhookService, (operation) =>
            state.waitUntil(operation),
        ),
    });
}
