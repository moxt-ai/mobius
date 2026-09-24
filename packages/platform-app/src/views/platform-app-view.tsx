import { AppWindow, Check, Clipboard, LoaderCircle, Pencil, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect } from "react";
import { ConfirmAction } from "../components/confirm-action.tsx";
import { CreateNameDialog } from "../components/create-name-dialog.tsx";
import { SecretDialog } from "../components/secret-dialog.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
import { platformDataTestId } from "../data-testid.ts";
import { createPlatformClient } from "../services/platform-client.ts";
import { usePlatformStore } from "../view-models/platform-app-view-model.ts";

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

export interface PlatformAppProps {
    readonly endpoint: string;
    readonly getToken: () => Promise<string>;
    readonly userControl: ReactNode;
    readonly organization: { readonly id: string; readonly name: string };
    readonly organizationControl: ReactNode;
}

function ErrorBanner({ message, onClose }: { readonly message: string; readonly onClose: () => void }) {
    if (message.length === 0) {
        return null;
    }
    return (
        <div
            className="mb-4 flex items-center justify-between rounded-lg border border-[#eccbcb] bg-[#fff1f1] px-3 py-2.5 text-sm text-[#8c3636] [&>button]:border-0 [&>button]:bg-transparent"
            role="alert"
        >
            <span>{message}</span>
            <button type="button" onClick={onClose} aria-label="Dismiss error">
                <X size={16} />
            </button>
        </div>
    );
}

function EmptyState({ children }: { readonly children: ReactNode }) {
    return (
        <div className="grid justify-items-center px-5 py-12 text-center text-[#819087] [&>svg]:text-[#94aa9b] [&>h1]:mt-3 [&>h1]:mb-1 [&>h1]:text-[#3b4941] [&>h3]:mt-3 [&>h3]:mb-1 [&>h3]:text-[#3b4941] [&>p]:m-0 [&>p]:max-w-[420px] [&>p]:text-sm [&>p]:leading-6">
            {children}
        </div>
    );
}

export function PlatformApp({ endpoint, getToken, userControl, organization, organizationControl }: PlatformAppProps) {
    const {
        apps,
        appTab,
        setAppTab,
        setApps,
        credentials,
        setCredentials,
        failCredentials,
        selectedAppId,
        setSelectedAppId,
        rename,
        setRename,
        busy,
        setBusy,
        error,
        setError,
        notice,
        setNotice,
        secret,
        setSecret,
        secretVisible,
        setSecretVisible,
    } = usePlatformStore();

    const client = useCallback(() => createPlatformClient(endpoint, getToken), [endpoint, getToken]);

    useEffect(() => {
        if (notice === null) {
            return;
        }
        const timer = window.setTimeout(() => setNotice(""), 4_000);
        return () => window.clearTimeout(timer);
    }, [notice, setNotice]);

    const perform = async (operation: string, action: () => Promise<void>): Promise<boolean> => {
        setBusy(operation);
        setError("");
        setNotice("");
        try {
            await action();
            return true;
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The Platform operation failed");
            return false;
        } finally {
            setBusy("");
        }
    };

    const selectedTenantId = organization.id;
    const selectedTenant = { tenantId: organization.id, displayName: organization.name };
    useEffect(() => {
        const controller = new AbortController();
        void client()
            .listApps(selectedTenantId, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
            .then((listed) => {
                setApps(listed);
                setSelectedAppId((current) =>
                    listed.some((app) => app.appId === current) ? current : (listed.at(0)?.appId ?? ""),
                );
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setError(cause instanceof Error ? cause.message : "Could not load apps");
                }
            });
        return () => controller.abort();
    }, [client, selectedTenantId, setSelectedAppId, setError, setApps]);

    useEffect(() => {
        if (selectedAppId.length === 0) {
            return;
        }
        const controller = new AbortController();
        void client()
            .listAppCredentials(selectedAppId, AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]))
            .then((listed) => {
                if (!controller.signal.aborted) {
                    setCredentials(selectedAppId, listed);
                }
            })
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    failCredentials(selectedAppId);
                    setError(cause instanceof Error ? cause.message : "Could not load keys");
                }
            });
        return () => controller.abort();
    }, [client, selectedAppId, setCredentials, failCredentials, setError]);

    const selectedApp = apps.find((app) => app.appId === selectedAppId);

    const createApp = async (name: string): Promise<boolean> => {
        return perform("create-app", async () => {
            const created = await client().createApp(selectedTenant.tenantId, name, AbortSignal.timeout(20_000));
            const listed = await client().listApps(selectedTenant.tenantId, AbortSignal.timeout(20_000));
            setApps(listed);
            setSelectedAppId(created.appId);
            setSecret({
                appId: created.appId,
                secret: created.defaultCredential.credential,
            });
            setSecretVisible(false);
        });
    };

    const issueCredential = (): void => {
        if (selectedApp === undefined) {
            return;
        }
        void perform("issue-key", async () => {
            const created = await client().issueAppCredential(
                selectedApp.appId,
                { permissions: APP_PERMISSIONS, projectIds: [] },
                AbortSignal.timeout(20_000),
            );
            setCredentials(
                selectedApp.appId,
                await client().listAppCredentials(selectedApp.appId, AbortSignal.timeout(20_000)),
            );
            setSecret({
                appId: created.appId,
                secret: created.credential,
            });
            setSecretVisible(false);
        });
    };

    const copy = (value: string, label: string): void => {
        void navigator.clipboard.writeText(value).then(
            () => setNotice(`${label} copied.`),
            () => setError(`${label} could not be copied.`),
        );
    };

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-[#f4f6f4] text-[#17221d]">
            <header className="z-40 flex h-[66px] shrink-0 items-center justify-between border-b border-[#dde3df] bg-white px-4 md:px-[30px]">
                <a
                    href="#workspace"
                    className="flex items-center gap-2 text-[17px] font-bold text-[#17221d] no-underline [&>small]:border-l [&>small]:border-[#dde3df] [&>small]:pl-2 [&>small]:text-[13px] [&>small]:font-medium [&>small]:text-[#819087] [&>span]:grid [&>span]:size-[31px] [&>span]:place-items-center [&>span]:rounded-lg [&>span]:bg-[#168247] [&>span]:font-extrabold [&>span]:text-white"
                >
                    <span>M</span> Mobius <small>Platform</small>
                </a>
                {userControl}
            </header>
            <div
                className="flex min-h-0 flex-1 flex-col overflow-hidden md:grid md:grid-cols-[254px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
                id="workspace"
            >
                <aside className="flex min-h-0 shrink-0 flex-col border-b border-[#dde3df] bg-[#fafbfa] p-4 md:border-r md:border-b-0 md:px-4 md:py-6">
                    <div className="flex items-center justify-between px-2 pb-3 text-[11px] font-bold uppercase tracking-[.1em] text-[#7a8780] [&>button]:grid [&>button]:size-[30px] [&>button]:place-items-center [&>button]:rounded-lg [&>button]:border-0 [&>button]:bg-transparent hover:[&>button]:bg-[#eaf3ed] hover:[&>button]:text-[#168247]">
                        <span>Organization</span>
                    </div>
                    <nav
                        className="flex min-h-0 gap-1 overflow-x-auto overscroll-contain md:block md:overflow-x-hidden md:overflow-y-auto"
                        aria-label="Organization"
                    >
                        {organizationControl}
                    </nav>
                </aside>
                <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
                    <div className="mx-auto w-full max-w-[1240px] px-4 py-8 md:px-12 md:py-12">
                        <ErrorBanner message={error} onClose={() => setError("")} />
                        <section className="flex flex-col items-start justify-between gap-6 pb-8 md:flex-row md:items-end [&_h1]:mb-2 [&_h1]:text-4xl [&_h1]:font-bold [&_h1]:tracking-[-.035em] [&_code]:text-xs [&_code]:text-[#78857e]">
                            <div>
                                <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#168247]">
                                    Organization workspace
                                </p>
                                <h1>{selectedTenant.displayName}</h1>
                                <code>{selectedTenant.tenantId}</code>
                            </div>
                        </section>
                        <section className="mt-4 rounded-xl border border-[#dde3df] bg-white p-5 shadow-sm md:p-7">
                            <div className="flex flex-col items-start justify-between gap-6 border-b border-[#e8ece9] pb-6 md:flex-row md:items-center [&_h2]:m-0 [&_h2]:text-xl [&_h2]:font-bold [&_p:last-child]:mt-1.5 [&_p:last-child]:text-sm [&_p:last-child]:text-[#69766f]">
                                <div>
                                    <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#168247]">
                                        Applications
                                    </p>
                                    <h2>Your apps</h2>
                                    <p>Each app has a stable ID and its own server credentials.</p>
                                </div>
                                <CreateNameDialog
                                    title="Create app"
                                    description={`Create an application in ${selectedTenant.displayName}. You’ll receive its App ID and first secret.`}
                                    label="Application name"
                                    placeholder="My application"
                                    busy={busy.length > 0}
                                    error={error}
                                    onOpen={() => setError("")}
                                    onCreate={createApp}
                                >
                                    <button
                                        className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#168247] px-3.5 font-bold text-white hover:bg-[#11683a] disabled:cursor-not-allowed disabled:opacity-50"
                                        type="button"
                                        disabled={busy.length > 0}
                                    >
                                        <Plus size={16} />
                                        Create app
                                    </button>
                                </CreateNameDialog>
                            </div>
                            {apps.length === 0 ? (
                                <EmptyState>
                                    <AppWindow size={30} />
                                    <h3>No applications yet</h3>
                                    <p>Create an app to receive its App ID and first secret.</p>
                                </EmptyState>
                            ) : (
                                <div className="grid grid-cols-1 gap-3 pt-5 sm:grid-cols-2 xl:grid-cols-3">
                                    {apps.map((app) => (
                                        <button
                                            type="button"
                                            key={app.appId}
                                            className={
                                                app.appId === selectedAppId
                                                    ? "grid min-w-0 gap-2 rounded-xl border-2 border-[#55a674] bg-[#fbfefc] p-4 text-left text-inherit [&>strong]:overflow-hidden [&>strong]:text-ellipsis [&>strong]:whitespace-nowrap [&>code]:overflow-hidden [&>code]:text-ellipsis [&>code]:text-[11px] [&>code]:text-[#69776f] [&>span:last-child]:text-[11px] [&>span:last-child]:text-[#8a958e]"
                                                    : "grid min-w-0 gap-2 rounded-xl border border-[#dde3df] bg-white p-4 text-left text-inherit hover:border-[#a8c8b2] hover:shadow-md [&>strong]:overflow-hidden [&>strong]:text-ellipsis [&>strong]:whitespace-nowrap [&>code]:overflow-hidden [&>code]:text-ellipsis [&>code]:text-[11px] [&>code]:text-[#69776f] [&>span:last-child]:text-[11px] [&>span:last-child]:text-[#8a958e]"
                                            }
                                            onClick={() => setSelectedAppId(app.appId)}
                                            data-testid={platformDataTestId.applicationChoice}
                                        >
                                            <span className="mb-0.5 grid size-[38px] place-items-center rounded-lg bg-[#e7f3eb] text-[#168247]">
                                                <AppWindow size={20} />
                                            </span>
                                            <strong>{app.displayName}</strong>
                                            <code>{app.appId}</code>
                                            <span>Created {new Date(app.createdAt).toLocaleDateString()}</span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </section>
                        {selectedApp === undefined ? null : credentials.kind === "loading" ? (
                            <section
                                className="mt-5 flex min-h-64 items-center justify-center gap-3 rounded-xl border border-[#dde3df] bg-white p-7 text-sm text-[#69766f] shadow-sm"
                                role="status"
                                aria-live="polite"
                            >
                                <LoaderCircle
                                    className="motion-safe:animate-spin text-[#168247]"
                                    size={24}
                                    aria-hidden="true"
                                />
                                <span>Loading application…</span>
                            </section>
                        ) : credentials.kind === "failed" ? null : (
                            <section className="mt-5 rounded-xl border border-[#dde3df] bg-white p-5 shadow-sm md:p-7">
                                <div className="flex flex-col items-start justify-between gap-6 border-b border-[#e8ece9] pb-6 md:flex-row md:items-center [&_h2]:m-0 [&_h2]:text-xl [&_h2]:font-bold [&_p:last-child]:mt-1.5 [&_p:last-child]:text-sm [&_p:last-child]:text-[#69766f]">
                                    <div>
                                        <p className="mb-2 text-[10px] font-extrabold uppercase tracking-[.13em] text-[#168247]">
                                            Selected application
                                        </p>
                                        <h2>{selectedApp.displayName}</h2>
                                        <button
                                            type="button"
                                            className="mt-2 flex items-center gap-2 border-0 bg-transparent p-0 text-xs text-[#718077] hover:text-[#168247]"
                                            onClick={() => copy(selectedApp.appId, "App ID")}
                                        >
                                            <code>{selectedApp.appId}</code>
                                            <Clipboard size={14} /> Copy App ID
                                        </button>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#ccd5cf] bg-white px-3.5 font-bold text-[#45534b] hover:bg-[#fafbfa]"
                                            onClick={() => setRename({ kind: "app", name: selectedApp.displayName })}
                                        >
                                            <Pencil size={15} /> Rename app
                                        </button>
                                        <ConfirmAction
                                            title={`Delete ${selectedApp.displayName}?`}
                                            description="Its projects and credentials will become unavailable. This cannot be undone."
                                            onConfirm={() =>
                                                void perform("delete-app", async () => {
                                                    await client().deleteApp(
                                                        selectedApp.appId,
                                                        AbortSignal.timeout(20_000),
                                                    );
                                                    setApps(
                                                        await client().listApps(
                                                            selectedTenant.tenantId,
                                                            AbortSignal.timeout(20_000),
                                                        ),
                                                    );
                                                    setSelectedAppId("");
                                                })
                                            }
                                        >
                                            <button
                                                type="button"
                                                className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#e2c9c9] bg-[#fffafa] px-3.5 font-bold text-[#b83e3e] hover:bg-[#fff1f1]"
                                            >
                                                <Trash2 size={15} /> Delete app
                                            </button>
                                        </ConfirmAction>
                                    </div>
                                </div>
                                {rename.kind === "app" ? (
                                    <form
                                        className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[#dde3df] bg-white p-3.5 [&_input]:w-[220px] [&_input]:rounded-lg [&_input]:border [&_input]:border-[#ccd5cf] [&_input]:px-3 [&_input]:py-2"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            void perform("rename-app", async () => {
                                                const updated = await client().updateApp(
                                                    selectedApp.appId,
                                                    rename.name,
                                                    AbortSignal.timeout(20_000),
                                                );
                                                setApps(
                                                    apps.map((app) => (app.appId === updated.appId ? updated : app)),
                                                );
                                                setRename({ kind: "idle" });
                                            });
                                        }}
                                    >
                                        <input
                                            value={rename.name}
                                            onChange={(event) => setRename({ kind: "app", name: event.target.value })}
                                            required
                                            maxLength={120}
                                        />
                                        <button
                                            className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#168247] px-3.5 font-bold text-white hover:bg-[#11683a] disabled:cursor-not-allowed disabled:opacity-50"
                                            type="submit"
                                        >
                                            Save name
                                        </button>
                                        <button
                                            className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#ccd5cf] bg-white px-3.5 font-bold text-[#45534b] hover:bg-[#fafbfa]"
                                            type="button"
                                            onClick={() => setRename({ kind: "idle" })}
                                        >
                                            Cancel
                                        </button>
                                    </form>
                                ) : null}
                                <Tabs
                                    value={appTab}
                                    onValueChange={(value) => setAppTab(value === "options" ? "options" : "api-keys")}
                                >
                                    <TabsList className="mt-6" aria-label="Application settings">
                                        <TabsTrigger value="api-keys">API keys</TabsTrigger>
                                    </TabsList>
                                    <TabsContent value="api-keys">
                                        <div className="mt-6 flex flex-col items-start justify-between gap-4 md:flex-row md:items-center [&_h3]:m-0 [&_h3]:text-xl [&_h3]:font-bold [&_p]:mt-1.5 [&_p]:text-sm [&_p]:text-[#69766f]">
                                            <div>
                                                <h3 id="app-keys-title">App keys</h3>
                                                <p>
                                                    Secrets cannot be viewed again. Choose Create key to get a new app
                                                    secret. Keys do not expire. Use app secrets only on trusted servers.
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                className="inline-flex min-h-[39px] items-center justify-center gap-2 rounded-lg border border-[#168247] bg-[#168247] px-3.5 font-bold text-white hover:bg-[#11683a] disabled:cursor-not-allowed disabled:opacity-50"
                                                onClick={issueCredential}
                                                disabled={busy.length > 0}
                                            >
                                                <Plus size={16} /> Create key
                                            </button>
                                        </div>
                                        <div className="mt-4 overflow-x-auto rounded-lg border border-[#dde3df]">
                                            <div className="grid min-h-[38px] min-w-[660px] grid-cols-[minmax(150px,1.4fr)_1fr_.7fr_40px] items-center gap-3 bg-[#f8faf8] px-3.5 py-2 text-[10px] font-bold uppercase tracking-[.06em] text-[#849087]">
                                                <span>App secret</span>
                                                <span>Created</span>
                                                <span>Status</span>
                                                <span />
                                            </div>
                                            {credentials.items.map((credential, index) => (
                                                <div
                                                    className="grid min-h-14 min-w-[660px] grid-cols-[minmax(150px,1.4fr)_1fr_.7fr_40px] items-center gap-3 border-t border-[#e8ece9] px-3.5 py-2 text-xs text-[#5f6c65] first:border-t-0"
                                                    key={credential.credentialId}
                                                >
                                                    <span>Only shown when created</span>
                                                    <span>{new Date(credential.issuedAt).toLocaleDateString()}</span>
                                                    <span
                                                        className={
                                                            credential.revokedAt.length > 0
                                                                ? "w-fit rounded-full bg-[#f5e9e9] px-2 py-1 text-[10px] font-bold uppercase text-[#8b5555]"
                                                                : "w-fit rounded-full bg-[#e5f3e9] px-2 py-1 text-[10px] font-bold uppercase text-[#168247]"
                                                        }
                                                    >
                                                        {credential.revokedAt.length > 0 ? "Revoked" : "Active"}
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className="grid size-[30px] place-items-center rounded-lg border-0 bg-transparent text-[#718078] hover:bg-[#eaf3ed] hover:text-[#168247] disabled:opacity-50"
                                                        aria-label={`Revoke key ${index + 1}`}
                                                        data-testid={platformDataTestId.revokeCredential}
                                                        disabled={credential.revokedAt.length > 0 || busy.length > 0}
                                                        onClick={() =>
                                                            void perform(
                                                                `revoke-${credential.credentialId}`,
                                                                async () => {
                                                                    await client().revokeAppCredential(
                                                                        credential.credentialId,
                                                                        AbortSignal.timeout(20_000),
                                                                    );
                                                                    setCredentials(
                                                                        selectedApp.appId,
                                                                        await client().listAppCredentials(
                                                                            selectedApp.appId,
                                                                            AbortSignal.timeout(20_000),
                                                                        ),
                                                                    );
                                                                },
                                                            )
                                                        }
                                                    >
                                                        <Trash2 size={15} />
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </TabsContent>
                                </Tabs>
                            </section>
                        )}
                    </div>
                </main>
            </div>
            <div
                className="fixed right-4 bottom-4 left-4 z-[60] pointer-events-none sm:left-auto sm:max-w-sm"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {notice === null ? null : (
                    <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[#c9e1d1] bg-white px-4 py-3 text-sm text-[#176d3d] shadow-lg">
                        <Check size={18} className="shrink-0" />
                        <span className="flex-1">{notice.message}</span>
                        <button
                            type="button"
                            aria-label="Dismiss notification"
                            onClick={() => setNotice("")}
                            className="rounded-md p-1 text-[#69766f] hover:bg-[#eff2f0]"
                        >
                            <X size={16} />
                        </button>
                    </div>
                )}
            </div>
            <SecretDialog
                secret={secret}
                visible={secretVisible}
                onVisibleChange={setSecretVisible}
                onCopy={copy}
                onClose={() => setSecret(null)}
            />
        </div>
    );
}
