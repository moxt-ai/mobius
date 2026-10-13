import type {
    MobiusPlatformApp,
    MobiusPlatformAppCredentialMetadata,
    MobiusPlatformAppSessionStatusWebhook,
    MobiusPlatformProject,
    MobiusPlatformRecordingPolicy,
} from "@moxt-ai/mobius-sdk/platform";
import { useState } from "react";
import { createStore, useStore } from "zustand";

type RenameState = { readonly kind: "idle" } | { readonly kind: "app"; readonly name: string };

export interface RevealedSecret {
    readonly appId: string;
    readonly secret: string;
}

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

export function usePlatformStore() {
    const [store] = useState(() =>
        createStore<PlatformStore>()((set) => ({
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
                    state.selectedAppId === appId
                        ? { webhook: { kind: "ready", webhook } satisfies WebhookState }
                        : state,
                ),
            failWebhook: (appId) =>
                set((state) =>
                    state.selectedAppId === appId ? { webhook: { kind: "failed" } satisfies WebhookState } : state,
                ),
        })),
    );
    return useStore(store);
}
