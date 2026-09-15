import type { MobiusPlatformApp, MobiusPlatformAppCredentialMetadata } from "@moxt-ai/mobius-sdk/platform";
import { useState } from "react";
import { createStore, useStore } from "zustand";

type RenameState = { readonly kind: "idle" } | { readonly kind: "app"; readonly name: string };

export interface RevealedSecret {
    readonly appId: string;
    readonly secret: string;
}

interface PlatformStore {
    readonly apps: readonly MobiusPlatformApp[];
    readonly busy: string;
    readonly credentials:
        | { readonly kind: "loading" }
        | { readonly kind: "failed" }
        | { readonly kind: "ready"; readonly items: readonly MobiusPlatformAppCredentialMetadata[] };
    readonly error: string;
    readonly notice: { readonly message: string } | null;
    readonly rename: RenameState;
    readonly secret: RevealedSecret | null;
    readonly secretVisible: boolean;
    readonly selectedAppId: string;
    readonly setApps: (value: readonly MobiusPlatformApp[]) => void;
    readonly setBusy: (value: string) => void;
    readonly setCredentials: (appId: string, value: readonly MobiusPlatformAppCredentialMetadata[]) => void;
    readonly failCredentials: (appId: string) => void;
    readonly setError: (value: string) => void;
    readonly setNotice: (value: string) => void;
    readonly setRename: (value: RenameState) => void;
    readonly setSecret: (value: RevealedSecret | null) => void;
    readonly setSecretVisible: (value: boolean) => void;
    readonly setSelectedAppId: (value: string | ((current: string) => string)) => void;
}

export function usePlatformStore() {
    const [store] = useState(() =>
        createStore<PlatformStore>()((set) => ({
            apps: [],
            busy: "",
            credentials: { kind: "loading" },
            error: "",
            notice: null,
            rename: { kind: "idle" },
            secret: null,
            secretVisible: false,
            selectedAppId: "",
            setApps: (apps) => set({ apps }),
            setBusy: (busy) => set({ busy }),
            setCredentials: (appId, items) =>
                set((state) => (state.selectedAppId === appId ? { credentials: { kind: "ready", items } } : state)),
            failCredentials: (appId) =>
                set((state) => (state.selectedAppId === appId ? { credentials: { kind: "failed" } } : state)),
            setError: (error) => set({ error }),
            setNotice: (message) => set({ notice: message.length > 0 ? { message } : null }),
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
                              credentials: { kind: "loading" },
                              rename: { kind: "idle" },
                              error: "",
                          };
                }),
        })),
    );
    return useStore(store);
}
