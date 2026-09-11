import type {
    MobiusPlatformApp,
    MobiusPlatformAppCredentialMetadata,
    MobiusPlatformTenant,
} from "@moxt-ai/mobius-sdk/platform";
import { create } from "zustand";

type RenameState =
    | { readonly kind: "idle" }
    | { readonly kind: "tenant"; readonly name: string }
    | { readonly kind: "app"; readonly name: string };

export interface RevealedSecret {
    readonly appId: string;
    readonly credentialId: string;
    readonly publicCredentialId: string;
    readonly secret: string;
}

interface PlatformStore {
    readonly appName: string;
    readonly apps: readonly MobiusPlatformApp[];
    readonly busy: string;
    readonly credentials: readonly MobiusPlatformAppCredentialMetadata[];
    readonly error: string;
    readonly notice: string;
    readonly rename: RenameState;
    readonly secret: RevealedSecret | null;
    readonly secretVisible: boolean;
    readonly selectedAppId: string;
    readonly selectedTenantId: string;
    readonly tenantName: string;
    readonly tenants: readonly MobiusPlatformTenant[];
    readonly setAppName: (value: string) => void;
    readonly setApps: (value: readonly MobiusPlatformApp[]) => void;
    readonly setBusy: (value: string) => void;
    readonly setCredentials: (value: readonly MobiusPlatformAppCredentialMetadata[]) => void;
    readonly setError: (value: string) => void;
    readonly setNotice: (value: string) => void;
    readonly setRename: (value: RenameState) => void;
    readonly setSecret: (value: RevealedSecret | null) => void;
    readonly setSecretVisible: (value: boolean) => void;
    readonly setSelectedAppId: (value: string | ((current: string) => string)) => void;
    readonly setSelectedTenantId: (value: string | ((current: string) => string)) => void;
    readonly setTenantName: (value: string) => void;
    readonly setTenants: (value: readonly MobiusPlatformTenant[]) => void;
}

export const usePlatformStore = create<PlatformStore>()((set) => ({
    appName: "",
    apps: [],
    busy: "",
    credentials: [],
    error: "",
    notice: "",
    rename: { kind: "idle" },
    secret: null,
    secretVisible: false,
    selectedAppId: "",
    selectedTenantId: "",
    tenantName: "",
    tenants: [],
    setAppName: (appName) => set({ appName }),
    setApps: (apps) => set({ apps }),
    setBusy: (busy) => set({ busy }),
    setCredentials: (credentials) => set({ credentials }),
    setError: (error) => set({ error }),
    setNotice: (notice) => set({ notice }),
    setRename: (rename) => set({ rename }),
    setSecret: (secret) => set({ secret }),
    setSecretVisible: (secretVisible) => set({ secretVisible }),
    setSelectedAppId: (value) =>
        set((state) => ({ selectedAppId: typeof value === "function" ? value(state.selectedAppId) : value })),
    setSelectedTenantId: (value) =>
        set((state) => ({ selectedTenantId: typeof value === "function" ? value(state.selectedTenantId) : value })),
    setTenantName: (tenantName) => set({ tenantName }),
    setTenants: (tenants) => set({ tenants }),
}));
