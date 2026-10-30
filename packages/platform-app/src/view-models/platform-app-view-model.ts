import type {
    MobiusCreatedPlatformApp,
    MobiusPlatformApp,
    MobiusPlatformAppCredential,
    MobiusPlatformAppCredentialMetadata,
    MobiusPlatformAppSessionStatusWebhook,
    MobiusPlatformDeveloperClient,
    MobiusPlatformProject,
    MobiusPlatformRecordingPolicy,
} from "@moxt-ai/mobius-sdk/platform";
import { createStore } from "zustand/vanilla";

const APP_PERMISSIONS = Object.freeze([
    "artifact:read",
    "artifact:write",
    "interaction:respond",
    "project:event:read",
    "project:read",
    "runtime:pair",
    "runtime:read",
    "runtime:revoke",
    "session:delete",
    "session:read",
    "session:write",
]);

type CredentialClient = Pick<MobiusPlatformDeveloperClient, "issueAppCredential" | "listAppCredentials">;
type AppClient = Pick<MobiusPlatformDeveloperClient, "createApp" | "listApps">;

type RenameState = { readonly kind: "idle" } | { readonly kind: "app"; readonly name: string };

export type RevealedSecret =
    | { readonly kind: "app-credential"; readonly appId: string; readonly secret: string }
    | { readonly kind: "webhook-created"; readonly appId: string; readonly secret: string }
    | { readonly kind: "webhook-rotated"; readonly appId: string; readonly secret: string };

/** A Project together with the Recording policy that currently applies to it. */
export interface ProjectRecording {
    readonly policy: MobiusPlatformRecordingPolicy;
    readonly project: MobiusPlatformProject;
}

export type RecordingState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "ready"; readonly policy: MobiusPlatformRecordingPolicy };

export type ProjectsState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "ready"; readonly items: readonly ProjectRecording[] };

export type WebhookState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed" }
    | { readonly kind: "ready"; readonly webhook: MobiusPlatformAppSessionStatusWebhook };

interface PlatformStore {
    readonly createApp: (client: AppClient, tenantId: string, name: string, signal?: AbortSignal) => Promise<boolean>;
    readonly issueCredential: (client: CredentialClient, signal?: AbortSignal) => Promise<void>;
    readonly appRecording: RecordingState;
    readonly appTab: "api-keys" | "recording";
    readonly apps: readonly MobiusPlatformApp[];
    readonly busy: string;
    readonly credentials:
        | { readonly kind: "loading" }
        | { readonly kind: "failed" }
        | { readonly kind: "ready"; readonly items: readonly MobiusPlatformAppCredentialMetadata[] };
    readonly error: string;
    readonly notice: { readonly message: string } | null;
    readonly projects: ProjectsState;
    readonly rename: RenameState;
    readonly secret: RevealedSecret | null;
    readonly secretVisible: boolean;
    readonly selectedAppId: string;
    readonly webhook: WebhookState;
    readonly setApps: (value: readonly MobiusPlatformApp[]) => void;
    readonly setAppRecording: (appId: string, value: MobiusPlatformRecordingPolicy) => void;
    readonly failAppRecording: (appId: string) => void;
    readonly setAppTab: (value: "api-keys" | "recording") => void;
    readonly setBusy: (value: string) => void;
    readonly setCredentials: (appId: string, value: readonly MobiusPlatformAppCredentialMetadata[]) => void;
    readonly failCredentials: (appId: string) => void;
    readonly setError: (value: string) => void;
    readonly setNotice: (value: string) => void;
    readonly setProjects: (appId: string, value: readonly ProjectRecording[]) => void;
    readonly failProjects: (appId: string) => void;
    readonly setRename: (value: RenameState) => void;
    readonly setSecret: (value: RevealedSecret | null) => void;
    readonly setSecretVisible: (value: boolean) => void;
    readonly setSelectedAppId: (value: string | ((current: string) => string)) => void;
    readonly setWebhook: (appId: string, value: MobiusPlatformAppSessionStatusWebhook) => void;
    readonly failWebhook: (appId: string) => void;
}

/** A revocation is a recorded fact; whether the key authenticates otherwise is the Platform's answer. */
export function credentialStatus(credential: MobiusPlatformAppCredentialMetadata): "active" | "inactive" | "revoked" {
    if (credential.revokedAt.length > 0) {
        return "revoked";
    }
    return credential.active ? "active" : "inactive";
}

export function createPlatformStore() {
    return createStore<PlatformStore>()((set, get) => ({
        createApp: async (client, tenantId, name, signal = new AbortController().signal) => {
            if (get().busy.length > 0) {
                return false;
            }
            set({ busy: "create-app", error: "", notice: null });
            try {
                let created: MobiusCreatedPlatformApp;
                try {
                    created = await client.createApp(
                        tenantId,
                        name,
                        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                    );
                } catch (cause) {
                    signal.throwIfAborted();
                    set({ error: cause instanceof Error ? cause.message : "The app could not be created." });
                    return false;
                }
                // This one-time result is already committed; a later read cannot undo or recover it.
                get().setSelectedAppId(created.appId);
                set({
                    secret: {
                        kind: "app-credential",
                        appId: created.appId,
                        secret: created.defaultCredential.credential,
                    },
                    secretVisible: false,
                });
                try {
                    get().setApps(
                        await client.listApps(tenantId, AbortSignal.any([signal, AbortSignal.timeout(20_000)])),
                    );
                } catch {
                    signal.throwIfAborted();
                    set({ error: "The app was created, but the app list could not be refreshed." });
                }
                return true;
            } finally {
                set({ busy: "" });
            }
        },
        issueCredential: async (client, signal = new AbortController().signal) => {
            const { apps, busy, selectedAppId } = get();
            if (busy.length > 0 || !apps.some((app) => app.appId === selectedAppId)) {
                return;
            }
            set({ busy: "issue-key", error: "", notice: null });
            try {
                let created: MobiusPlatformAppCredential;
                try {
                    created = await client.issueAppCredential(
                        selectedAppId,
                        { permissions: APP_PERMISSIONS, projectIds: [] },
                        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                    );
                } catch (cause) {
                    signal.throwIfAborted();
                    set({ error: cause instanceof Error ? cause.message : "The key could not be created." });
                    return;
                }
                // This one-time result is already committed; a later read cannot undo or recover it.
                set({
                    secret: { kind: "app-credential", appId: created.appId, secret: created.credential },
                    secretVisible: false,
                });
                try {
                    const credentials = await client.listAppCredentials(
                        selectedAppId,
                        AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                    );
                    get().setCredentials(selectedAppId, credentials);
                } catch {
                    signal.throwIfAborted();
                    set((state) =>
                        state.selectedAppId === selectedAppId
                            ? { error: "The key was created, but the key list could not be refreshed." }
                            : state,
                    );
                }
            } finally {
                set({ busy: "" });
            }
        },
        appRecording: { kind: "loading" },
        apps: [],
        appTab: "api-keys",
        busy: "",
        credentials: { kind: "loading" },
        error: "",
        notice: null,
        projects: { kind: "loading" },
        rename: { kind: "idle" },
        secret: null,
        secretVisible: false,
        selectedAppId: "",
        webhook: { kind: "loading" },
        setApps: (apps) => set({ apps }),
        setAppRecording: (appId, policy) =>
            set((state) => (state.selectedAppId === appId ? { appRecording: { kind: "ready", policy } } : state)),
        failAppRecording: (appId) =>
            set((state) => (state.selectedAppId === appId ? { appRecording: { kind: "failed" } } : state)),
        setAppTab: (appTab) => set({ appTab }),
        setBusy: (busy) => set({ busy }),
        setCredentials: (appId, items) =>
            set((state) => (state.selectedAppId === appId ? { credentials: { kind: "ready", items } } : state)),
        failCredentials: (appId) =>
            set((state) => (state.selectedAppId === appId ? { credentials: { kind: "failed" } } : state)),
        setError: (error) => set({ error }),
        setNotice: (message) => set({ notice: message.length > 0 ? { message } : null }),
        setProjects: (appId, items) =>
            set((state) => (state.selectedAppId === appId ? { projects: { kind: "ready", items } } : state)),
        failProjects: (appId) =>
            set((state) => (state.selectedAppId === appId ? { projects: { kind: "failed" } } : state)),
        setRename: (rename) => set({ rename }),
        setSecret: (secret) => set({ secret }),
        setSecretVisible: (secretVisible) => set({ secretVisible }),
        setSelectedAppId: (value) =>
            set((state) => {
                const selectedAppId = typeof value === "function" ? value(state.selectedAppId) : value;
                return selectedAppId === state.selectedAppId
                    ? state
                    : {
                          selectedAppId,
                          appRecording: { kind: "loading" },
                          appTab: "api-keys",
                          credentials: { kind: "loading" },
                          projects: { kind: "loading" },
                          webhook: { kind: "loading" },
                          rename: { kind: "idle" },
                          error: "",
                      };
            }),
        setWebhook: (appId, webhook) =>
            set((state) =>
                state.selectedAppId === appId ? { webhook: { kind: "ready", webhook } satisfies WebhookState } : state,
            ),
        failWebhook: (appId) =>
            set((state) =>
                state.selectedAppId === appId ? { webhook: { kind: "failed" } satisfies WebhookState } : state,
            ),
    }));
}
