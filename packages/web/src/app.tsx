import { useEffect, useState } from "react";
import {
    BrowserRouter,
    Link,
    Navigate,
    Outlet,
    Route,
    Routes,
    useLocation,
    useOutletContext,
    useParams,
} from "react-router";
import { AgentSettingsPage } from "@/components/agent-settings-page";
import { ChannelAccessPage } from "@/components/channel-access-panel";
import { PairingPage } from "@/components/pairing-page";
import { RuntimeManagementPage } from "@/components/runtime-management-page";
import { WorkspaceRouteProvider } from "@/components/workspace-route-provider";
import {
    type ChannelConnection,
    isIdentifier,
    PairingApiError,
    StandaloneProjectRuntimeCredentialAuthority,
} from "@/domain/channel";
import {
    ChannelWorkspaceRoutePaths,
    decodeProjectRuntimeRouteState,
    ProjectRuntimeWorkspaceRoutePaths,
    type WorkspaceRoutePaths,
} from "@/services/app-routes";
import {
    readChannelConnection,
    readProjectRuntimeConnection,
    redeemChannelAccessGrantFromLocation,
} from "@/services/pairing-api";
import { initializeRuntimeTransport } from "@/services/runtime-transport";
import { useRuntimeStore } from "@/store/runtime-store";

interface ManagementContext {
    readonly connection: ChannelConnection;
    readonly routes: WorkspaceRoutePaths;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
}
type ConnectionState =
    | { readonly kind: "loading" }
    | { readonly kind: "ready"; readonly key: string; readonly connection: ChannelConnection }
    | { readonly kind: "failed"; readonly key: string; readonly message: string };

function ManagementWorkspace({
    connection,
    routes,
}: {
    readonly connection: ChannelConnection;
    readonly routes: WorkspaceRoutePaths;
}) {
    const [collapsed, setCollapsed] = useState(false);
    const sidebarOpen = useRuntimeStore((state) => state.sidebarOpen);
    useEffect(() => initializeRuntimeTransport(connection), [connection]);
    const context: ManagementContext = {
        connection,
        routes,
        desktopSidebarCollapsed: collapsed,
        onToggleDesktopSidebar: () => setCollapsed((value) => !value),
    };
    return (
        <WorkspaceRouteProvider routes={routes}>
            <div className="flex h-dvh bg-background">
                <nav
                    aria-label="Runtime management"
                    id="runtime-navigation"
                    className={`${sidebarOpen ? "block" : "hidden"} ${collapsed ? "lg:hidden" : "lg:block"} shrink-0 border-r border-black/10 bg-white p-4`}
                >
                    <p className="mb-5 font-semibold">Mobius</p>
                    <div className="flex flex-col gap-4">
                        <Link to={routes.rootPath} onClick={() => useRuntimeStore.getState().setSidebarOpen(false)}>
                            Local Agents
                        </Link>
                        <Link to={routes.runtimesPath} onClick={() => useRuntimeStore.getState().setSidebarOpen(false)}>
                            Local machines
                        </Link>
                        {routes.access.kind === "available" && (
                            <Link to={routes.access.path}>Access from other devices</Link>
                        )}
                        <Link to="/">Pair another machine</Link>
                        <a href="https://morty.build/" target="_blank" rel="noreferrer">
                            Open Morty
                        </a>
                    </div>
                </nav>
                <main className="flex min-w-0 flex-1 flex-col">
                    <Outlet context={context} />
                </main>
            </div>
        </WorkspaceRouteProvider>
    );
}
function ManagementRoute({ projectRuntime }: { readonly projectRuntime: boolean }) {
    const params = useParams();
    const channelId = params["channelId"] ?? "";
    const projectId = params["projectId"] ?? "";
    const runtimeId = params["runtimeId"] ?? "";
    const location = useLocation();
    const accessChannelId = decodeProjectRuntimeRouteState(location.state);
    const key = projectRuntime ? `${projectId}:${runtimeId}` : channelId;
    const valid = projectRuntime ? isIdentifier(projectId) && isIdentifier(runtimeId) : isIdentifier(channelId);
    const [state, setState] = useState<ConnectionState>({ kind: "loading" });
    useEffect(() => {
        if (!valid) {
            return;
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
        setState({ kind: "loading" });
        const load = async (): Promise<void> => {
            try {
                if (!projectRuntime) {
                    await redeemChannelAccessGrantFromLocation(channelId, signal);
                }
                const connection = projectRuntime
                    ? await readProjectRuntimeConnection(projectId, runtimeId, signal, accessChannelId)
                    : await readChannelConnection(channelId, signal);
                signal.throwIfAborted();
                setState({ kind: "ready", key, connection });
            } catch (error) {
                if (!controller.signal.aborted) {
                    setState({
                        kind: "failed",
                        key,
                        message: error instanceof PairingApiError ? error.message : "The Runtime could not be loaded.",
                    });
                }
            }
        };
        void load();
        return () => controller.abort();
    }, [accessChannelId, channelId, key, projectId, projectRuntime, runtimeId, valid]);
    if (!valid) {
        return <p role="alert">Invalid Runtime address.</p>;
    }
    if (state.kind === "failed" && state.key === key) {
        return (
            <section>
                <p role="alert">{state.message}</p>
                <Link to="/">Start a new pairing</Link>
            </section>
        );
    }
    if (state.kind !== "ready" || state.key !== key) {
        return <p role="status">Loading Runtime…</p>;
    }
    const routes = projectRuntime
        ? new ProjectRuntimeWorkspaceRoutePaths(
              projectId,
              runtimeId,
              state.connection.accessChannelId,
              state.connection.credentialAuthority instanceof StandaloneProjectRuntimeCredentialAuthority,
          )
        : new ChannelWorkspaceRoutePaths(channelId);
    return <ManagementWorkspace connection={state.connection} routes={routes} key={key} />;
}
function AgentsRoute() {
    const context = useOutletContext<ManagementContext>();
    return (
        <AgentSettingsPage
            channelId={context.connection.channelId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
        />
    );
}
function MachinesRoute() {
    const context = useOutletContext<ManagementContext>();
    return (
        <RuntimeManagementPage
            accessChannelId={context.connection.accessChannelId}
            projectId={context.connection.projectId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
        />
    );
}
function AccessRoute() {
    const context = useOutletContext<ManagementContext>();
    return (
        <ChannelAccessPage
            channelId={context.connection.accessChannelId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
        />
    );
}
export function App() {
    return (
        <BrowserRouter>
            <Routes>
                <Route path="/" element={<PairingPage />} />
                <Route path="/channels/:channelId" element={<ManagementRoute projectRuntime={false} />}>
                    <Route index element={<AgentsRoute />} />
                    <Route path="runtimes" element={<MachinesRoute />} />
                    <Route path="access" element={<AccessRoute />} />
                    <Route path="*" element={<Navigate to=".." replace />} />
                </Route>
                <Route path="/projects/:projectId/runtimes/:runtimeId" element={<ManagementRoute projectRuntime />}>
                    <Route index element={<AgentsRoute />} />
                    <Route path="machines" element={<MachinesRoute />} />
                    <Route path="*" element={<Navigate to=".." replace />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </BrowserRouter>
    );
}
