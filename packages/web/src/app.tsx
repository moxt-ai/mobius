import { CircleAlert, Home, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    BrowserRouter,
    Navigate,
    Outlet,
    Route,
    Routes,
    useLocation,
    useNavigate,
    useOutletContext,
    useParams,
} from "react-router";
import { AgentInstallationPage } from "@/components/agent-installation-panel";
import { AgentSettingsPage } from "@/components/agent-settings-page";
import { ChannelAccessPage } from "@/components/channel-access-panel";
import { ChatComposer } from "@/components/chat-composer";
import { ChatHeader } from "@/components/chat-header";
import { ChatMessageList } from "@/components/chat-message-list";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { PairingPage } from "@/components/pairing-page";
import { RuntimeManagementPage } from "@/components/runtime-management-page";
import { Button } from "@/components/ui/button";
import { WorkspaceRouteProvider } from "@/components/workspace-route-provider";
import type { ChannelConnection, ChannelHistory } from "@/domain/channel";
import { isIdentifier, PairingApiError, StandaloneProjectRuntimeCredentialAuthority } from "@/domain/channel";
import {
    ChannelWorkspaceRoutePaths,
    decodeProjectRuntimeRouteState,
    ProjectRuntimeWorkspaceRoutePaths,
    type WorkspaceRoutePaths,
} from "@/services/app-routes";
import { ChannelHistorySynchronizer } from "@/services/channel-history-synchronizer";
import { closeMobiusTransport, initializeMobiusTransport } from "@/services/mobius-transport";
import {
    readChannelConnection,
    readChannelHistoryForSynchronization,
    readConnectionDirectory,
    readProjectRuntimeConnection,
    readSessionHistory,
    redeemChannelAccessGrantFromLocation,
} from "@/services/pairing-api";
import {
    type DesktopSidebarLayoutState,
    decodeSidebarLayoutPreference,
    encodeSidebarLayoutPreference,
    toggleSidebar,
} from "@/services/workspace-layout";
import { useChatStore } from "@/store/chat-store";

const SIDEBAR_LAYOUT_STORAGE_KEY = "mobius:conversation-sidebar-layout";

export interface ChatProps {
    readonly accessChannelId: string;
    readonly channelId: string;
    readonly connection: ChannelConnection;
    readonly desktopSidebarCollapsed: boolean;
    readonly onCreateConversation: () => void;
    readonly onToggleDesktopSidebar: () => void;
    readonly projectId: string;
    readonly routes: WorkspaceRoutePaths;
}

function initialSidebarLayout(): DesktopSidebarLayoutState {
    try {
        return decodeSidebarLayoutPreference(window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY));
    } catch {
        return decodeSidebarLayoutPreference(null);
    }
}

function ChannelErrorPage({ message, title }: { readonly message: string; readonly title: string }) {
    const navigate = useNavigate();
    return (
        <main className="flex h-dvh items-center justify-center bg-background p-6">
            <section className="pairing-card w-full max-w-[520px] rounded-2xl bg-white px-8 py-10 text-center">
                <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#b4232a]">
                    <CircleAlert className="size-5" />
                </span>
                <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">{title}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
                <Button className="mt-6" onClick={() => navigate("/")}>
                    <Home className="size-4" /> Start a new pairing
                </Button>
            </section>
        </main>
    );
}

function ChannelContentError({ message, title }: { readonly message: string; readonly title: string }) {
    const { routes } = useOutletContext<ChatProps>();
    const navigate = useNavigate();
    return (
        <section className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="w-full max-w-[520px] text-center">
                <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#b4232a]">
                    <CircleAlert className="size-5" />
                </span>
                <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">{title}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
                <Button className="mt-6" onClick={() => navigate(routes.rootPath, { replace: true })}>
                    Return to chat
                </Button>
            </div>
        </section>
    );
}

function ChannelLoadingPage() {
    return (
        <main aria-busy="true" aria-live="polite" className="flex h-dvh items-center justify-center bg-background p-6">
            <section className="pairing-card w-full max-w-[520px] rounded-2xl bg-white px-8 py-10 text-center">
                <LoaderCircle className="mx-auto size-6 animate-spin text-[#279a60]" />
                <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">Opening workspace</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Loading the selected local machine from the relay.
                </p>
            </section>
        </main>
    );
}

function SessionLoadingState() {
    return (
        <section
            aria-busy="true"
            aria-live="polite"
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
        >
            <LoaderCircle className="size-6 animate-spin text-[#279a60]" />
            <p className="text-sm text-muted-foreground">Loading this conversation.</p>
        </section>
    );
}

function ChannelWorkspace({
    connection,
    history,
    routes,
}: {
    readonly connection: ChannelConnection;
    readonly history: ChannelHistory;
    readonly routes: WorkspaceRoutePaths;
}) {
    const params = useParams<"sessionId">();
    const [initialSessionId] = useState(() => params.sessionId ?? "");
    const [workspaceReady, setWorkspaceReady] = useState(false);
    const agents = useChatStore((state) => state.agents);
    const channelConfigured = useChatStore((state) => state.channelConfigured);
    const configureChannel = useChatStore((state) => state.configureChannel);
    const createConversation = useChatStore((state) => state.createConversation);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);
    const location = useLocation();
    const navigate = useNavigate();
    const mainContentRef = useRef<HTMLElement>(null);
    const channelIndexOpen = location.pathname === routes.rootPath;
    const accessOpen = routes.access.kind === "available" && location.pathname === routes.access.path;
    const runtimesOpen = location.pathname === routes.runtimesPath;
    const settingsOpen = routes.isSessionSettingsPath(location.pathname);
    const managementPageOpen = accessOpen || runtimesOpen || settingsOpen;
    const [sidebarLayout, setSidebarLayout] = useState<DesktopSidebarLayoutState>(initialSidebarLayout);

    useEffect(() => {
        try {
            window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, encodeSidebarLayoutPreference(sidebarLayout));
        } catch {}
    }, [sidebarLayout]);

    useEffect(() => {
        configureChannel(connection, history, initialSessionId);
        setWorkspaceReady(true);
        const synchronizer = new ChannelHistorySynchronizer({
            applyHistory: (latestHistory) => {
                useChatStore.getState().reconcileHistory(latestHistory);
            },
            hasActiveTurns: () => useChatStore.getState().conversations.some((conversation) => conversation.isRunning),
            readHistory: async (signal) => {
                const store = useChatStore.getState();
                const active = store.conversations.find(
                    (conversation) => conversation.id === store.activeConversationId,
                );
                const activeSessionId =
                    active !== undefined && (active.id === active.sessionId || active.messages.length > 0)
                        ? active.sessionId
                        : "";
                // A Session whose turns are already loaded does not need re-reading on every refresh; the
                // active one always does. The first refresh therefore hydrates the whole directory, which
                // is what marks a running Session that is not the active one.
                const hydratedSessionIds = store.conversations
                    .filter((conversation) => conversation.hasLoadedTurns)
                    .map((conversation) => conversation.sessionId);
                return await readChannelHistoryForSynchronization(
                    connection,
                    activeSessionId,
                    hydratedSessionIds,
                    signal,
                );
            },
            reportFailure: (error) => {
                const message =
                    error instanceof PairingApiError
                        ? `${error.code}: ${error.message}`
                        : "The latest background task status could not be loaded.";
                useChatStore.getState().reportHistorySyncFailure(message);
            },
        });
        synchronizer.start();
        initializeMobiusTransport(connection, synchronizer.notifyActivity);
        return () => {
            synchronizer.stop();
            void closeMobiusTransport();
        };
    }, [configureChannel, connection, history, initialSessionId]);

    const createAndOpenConversation = useCallback((): void => {
        createConversation();
        const store = useChatStore.getState();
        const conversation = store.conversations.find(
            (candidate) => candidate.id === store.activeConversationId && candidate.isDraft,
        );
        if (conversation !== undefined) {
            void navigate(routes.newSessionPath);
        }
    }, [createConversation, navigate, routes]);

    useEffect(() => {
        const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
            if (
                event.key.toLowerCase() === "n" &&
                (event.metaKey || event.ctrlKey) &&
                !event.shiftKey &&
                !event.altKey
            ) {
                event.preventDefault();
                createAndOpenConversation();
            }
        };

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [createAndOpenConversation]);

    useEffect(() => {
        if (workspaceReady && location.pathname.length > 0) {
            mainContentRef.current?.focus({ preventScroll: true });
        }
    }, [location.pathname, workspaceReady]);

    if (!workspaceReady || !channelConfigured) {
        return <ChannelLoadingPage />;
    }
    if (agents.length === 0 && channelIndexOpen) {
        return <AgentInstallationPage />;
    }

    const context: ChatProps = {
        accessChannelId: connection.accessChannelId,
        channelId: connection.channelId,
        connection,
        desktopSidebarCollapsed: sidebarLayout.kind === "collapsed",
        onCreateConversation: createAndOpenConversation,
        onToggleDesktopSidebar: () => {
            setSidebarLayout((current) => toggleSidebar(current));
        },
        projectId: connection.projectId,
        routes,
    };

    return (
        <>
            <a
                className="fixed top-3 left-3 z-50 -translate-y-[180%] rounded-lg bg-[#2fb872] px-[13px] py-[9px] text-[13px] font-semibold text-[#062f1c] no-underline transition-transform duration-150 motion-reduce:transition-none focus:translate-y-0"
                href="#main-content"
            >
                {runtimesOpen
                    ? "Skip to local machines"
                    : accessOpen
                      ? "Skip to device access"
                      : settingsOpen
                        ? "Skip to Agent settings"
                        : "Skip to conversation"}
            </a>
            <div className="flex h-dvh w-full bg-background">
                <ConversationSidebar
                    layout={sidebarLayout}
                    managementPageOpen={managementPageOpen}
                    onCreateConversation={createAndOpenConversation}
                    onLayoutChange={setSidebarLayout}
                />
                <main
                    className="flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none"
                    id="main-content"
                    inert={sidebarOpen ? true : undefined}
                    ref={mainContentRef}
                    tabIndex={-1}
                >
                    <Outlet context={context} />
                </main>
            </div>
        </>
    );
}

abstract class ChannelRouteState {
    abstract readonly status: string;
}

class LoadingChannelRouteState extends ChannelRouteState {
    readonly status = "loading";
}

class ReadyChannelRouteState extends ChannelRouteState {
    readonly connection: ChannelConnection;
    readonly history: ChannelHistory;
    readonly status = "ready";

    constructor(connection: ChannelConnection, history: ChannelHistory) {
        super();
        this.connection = connection;
        this.history = history;
    }
}

class FailedChannelRouteState extends ChannelRouteState {
    readonly message: string;
    readonly status = "failed";

    constructor(message: string) {
        super();
        this.message = message;
    }
}

abstract class SessionRouteLoadState {
    readonly sessionId: string;

    protected constructor(sessionId: string) {
        this.sessionId = sessionId;
    }
}

class LoadingSessionRouteState extends SessionRouteLoadState {
    constructor(sessionId: string) {
        super(sessionId);
    }
}

class ReadySessionRouteState extends SessionRouteLoadState {
    constructor(sessionId: string) {
        super(sessionId);
    }
}

class FailedSessionRouteState extends SessionRouteLoadState {
    readonly message: string;

    constructor(sessionId: string, message: string) {
        super(sessionId);
        this.message = message;
    }
}

function ChannelRoute() {
    const params = useParams<"channelId">();
    const channelId = params.channelId ?? "";
    const [state, setState] = useState<ChannelRouteState>(new LoadingChannelRouteState());

    useEffect(() => {
        if (!isIdentifier(channelId)) {
            return;
        }
        let active = true;
        const controller = new AbortController();
        setState(new LoadingChannelRouteState());
        const load = async (): Promise<void> => {
            try {
                await redeemChannelAccessGrantFromLocation(channelId, controller.signal);
                // Validate the channel-scoped credential before using it for broader
                // project history reads so revoked access reports the channel boundary.
                const connection = await readChannelConnection(channelId, controller.signal);
                const history = await readConnectionDirectory(connection, controller.signal);
                if (active) {
                    setState(new ReadyChannelRouteState(connection, history));
                }
            } catch (error) {
                if (!active) {
                    return;
                }
                const message =
                    error instanceof PairingApiError
                        ? `${error.code}: ${error.message}`
                        : "The channel could not be loaded.";
                setState(new FailedChannelRouteState(message));
            }
        };
        void load();
        return () => {
            active = false;
            controller.abort();
        };
    }, [channelId]);

    if (!isIdentifier(channelId)) {
        return <ChannelErrorPage message="The channel route is malformed." title="Invalid channel" />;
    }
    if (state instanceof ReadyChannelRouteState && state.connection.channelId === channelId) {
        const routes = new ChannelWorkspaceRoutePaths(channelId);
        return (
            <WorkspaceRouteProvider routes={routes}>
                <ChannelWorkspace
                    connection={state.connection}
                    history={state.history}
                    key={state.connection.channelId}
                    routes={routes}
                />
            </WorkspaceRouteProvider>
        );
    }
    if (state instanceof FailedChannelRouteState) {
        return <ChannelErrorPage message={state.message} title="Channel unavailable" />;
    }
    return <ChannelLoadingPage />;
}

function ProjectRuntimeRoute() {
    const params = useParams();
    const projectId = params["projectId"] ?? "";
    const runtimeId = params["runtimeId"] ?? "";
    const [state, setState] = useState<ChannelRouteState>(new LoadingChannelRouteState());
    const location = useLocation();
    const [accessChannelId] = useState(() => decodeProjectRuntimeRouteState(location.state));

    useEffect(() => {
        if (!isIdentifier(projectId) || !isIdentifier(runtimeId)) {
            return;
        }
        let active = true;
        const controller = new AbortController();
        setState(new LoadingChannelRouteState());
        const load = async (): Promise<void> => {
            try {
                const connection = await readProjectRuntimeConnection(
                    projectId,
                    runtimeId,
                    controller.signal,
                    accessChannelId,
                );
                const history = await readConnectionDirectory(connection, controller.signal);
                if (active) {
                    setState(new ReadyChannelRouteState(connection, history));
                }
            } catch (error) {
                if (!active) {
                    return;
                }
                const message =
                    error instanceof PairingApiError
                        ? `${error.code}: ${error.message}`
                        : "The selected Project Runtime could not be loaded.";
                setState(new FailedChannelRouteState(message));
            }
        };
        void load();
        return () => {
            active = false;
            controller.abort();
        };
    }, [accessChannelId, projectId, runtimeId]);

    if (!isIdentifier(projectId) || !isIdentifier(runtimeId)) {
        return <ChannelErrorPage message="The Project Runtime route is malformed." title="Invalid Runtime" />;
    }
    if (state instanceof ReadyChannelRouteState && state.connection.projectId === projectId) {
        const routes = new ProjectRuntimeWorkspaceRoutePaths(
            projectId,
            runtimeId,
            state.connection.accessChannelId,
            state.connection.credentialAuthority instanceof StandaloneProjectRuntimeCredentialAuthority,
        );
        return (
            <WorkspaceRouteProvider routes={routes}>
                <ChannelWorkspace
                    connection={state.connection}
                    history={state.history}
                    key={`${projectId}:${runtimeId}`}
                    routes={routes}
                />
            </WorkspaceRouteProvider>
        );
    }
    if (state instanceof FailedChannelRouteState) {
        return <ChannelErrorPage message={state.message} title="Runtime unavailable" />;
    }
    return <ChannelLoadingPage />;
}

function ChannelIndexRoute() {
    const { routes } = useOutletContext<ChatProps>();
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const conversations = useChatStore((state) => state.conversations);
    const conversation = conversations.find((candidate) => candidate.id === activeConversationId);
    if (conversation === undefined) {
        return (
            <ChannelContentError message="This channel does not have a Session to open." title="Session unavailable" />
        );
    }
    return (
        <Navigate
            replace
            to={conversation.isDraft ? routes.newSessionPath : routes.sessionPath(conversation.sessionId)}
        />
    );
}

function NewSessionRoute() {
    const context = useOutletContext<ChatProps>();
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const conversations = useChatStore((state) => state.conversations);
    const createConversation = useChatStore((state) => state.createConversation);
    const selectConversation = useChatStore((state) => state.selectConversation);
    const navigate = useNavigate();
    const initialDraft = conversations.find((candidate) => candidate.isDraft);
    const [conversationId, setConversationId] = useState(() => initialDraft?.id ?? "");
    const conversation = conversations.find((candidate) => candidate.id === conversationId);

    useLayoutEffect(() => {
        if (conversationId.length > 0) {
            return;
        }
        createConversation();
        const created = useChatStore.getState().conversations.find((candidate) => candidate.isDraft);
        if (created !== undefined) {
            setConversationId(created.id);
        }
    }, [conversationId, createConversation]);

    useLayoutEffect(() => {
        if (conversation !== undefined && conversation.id !== activeConversationId) {
            selectConversation(conversation.id);
        }
    }, [activeConversationId, conversation, selectConversation]);

    useEffect(() => {
        if (conversation !== undefined && !conversation.isDraft) {
            void navigate(context.routes.sessionPath(conversation.sessionId), { replace: true });
        }
    }, [context.routes, conversation, navigate]);

    if (conversation === undefined || conversation.id !== activeConversationId) {
        return <SessionLoadingState />;
    }
    return <Outlet context={context} />;
}

function SessionRoute() {
    const context = useOutletContext<ChatProps>();
    const params = useParams<"sessionId">();
    const sessionId = params.sessionId ?? "";
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const conversations = useChatStore((state) => state.conversations);
    const selectConversation = useChatStore((state) => state.selectConversation);
    const conversation = conversations.find((candidate) => candidate.sessionId === sessionId);
    const [state, setState] = useState<SessionRouteLoadState>(() => new LoadingSessionRouteState(sessionId));
    const loadedSessionId = useRef("");
    const persistedSession = conversation !== undefined && conversation.id === conversation.sessionId;

    useLayoutEffect(() => {
        if (conversation !== undefined && conversation.id !== activeConversationId) {
            selectConversation(conversation.id);
        }
    }, [activeConversationId, conversation, selectConversation]);

    useEffect(() => {
        if (!isIdentifier(sessionId) || (conversation !== undefined && !persistedSession)) {
            setState(new ReadySessionRouteState(sessionId));
            return;
        }
        if (loadedSessionId.current === sessionId) {
            setState(new ReadySessionRouteState(sessionId));
            return;
        }
        const controller = new AbortController();
        setState(new LoadingSessionRouteState(sessionId));
        void readSessionHistory(context.connection, sessionId, controller.signal)
            .then((history) => {
                if (controller.signal.aborted) {
                    return;
                }
                loadedSessionId.current = sessionId;
                useChatStore.getState().reconcileHistory(history);
                setState(new ReadySessionRouteState(sessionId));
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                const message =
                    error instanceof PairingApiError
                        ? `${error.code}: ${error.message}`
                        : "This Session could not be loaded.";
                setState(new FailedSessionRouteState(sessionId, message));
            });
        return () => controller.abort();
    }, [context.connection, conversation, persistedSession, sessionId]);

    if (!isIdentifier(sessionId)) {
        return <ChannelContentError message="The Session route is malformed." title="Invalid Session" />;
    }
    if (conversation === undefined) {
        if (state instanceof LoadingSessionRouteState) {
            return <SessionLoadingState />;
        }
        if (state instanceof FailedSessionRouteState) {
            return <ChannelContentError message={state.message} title="Session unavailable" />;
        }
        return (
            <ChannelContentError
                message="This Session is not available in the paired channel history."
                title="Session unavailable"
            />
        );
    }
    if (conversation.id !== activeConversationId) {
        return null;
    }
    if (persistedSession && state.sessionId !== sessionId) {
        return <SessionLoadingState />;
    }
    if (persistedSession && state instanceof LoadingSessionRouteState) {
        return <SessionLoadingState />;
    }
    if (persistedSession && state instanceof FailedSessionRouteState) {
        return <ChannelContentError message={state.message} title="Session unavailable" />;
    }
    return <Outlet context={context} />;
}

export function Chat({ connection, desktopSidebarCollapsed, onCreateConversation, onToggleDesktopSidebar }: ChatProps) {
    const announcement = useChatStore((state) => state.announcement);
    const activeConversationMessageCount = useChatStore((state) => {
        const conversation = state.conversations.find((candidate) => candidate.id === state.activeConversationId);
        return conversation?.messages.length ?? 0;
    });
    return (
        <>
            <ChatHeader
                desktopSidebarCollapsed={desktopSidebarCollapsed}
                onCreateConversation={onCreateConversation}
                onToggleDesktopSidebar={onToggleDesktopSidebar}
            />
            <section aria-label="Agent conversation" className="flex min-h-0 flex-1 flex-col">
                <ChatMessageList connection={connection} />
                {activeConversationMessageCount > 0 && <ChatComposer placement="active" />}
                <p aria-live="polite" className="sr-only">
                    {announcement}
                </p>
            </section>
        </>
    );
}

function ConversationRoutePage() {
    const context = useOutletContext<ChatProps>();
    return <Chat {...context} />;
}

function AgentSettingsRoutePage() {
    const context = useOutletContext<ChatProps>();
    return (
        <AgentSettingsPage
            channelId={context.channelId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
        />
    );
}

function ChannelAccessRoutePage() {
    const context = useOutletContext<ChatProps>();
    return (
        <ChannelAccessPage
            channelId={context.accessChannelId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
        />
    );
}

function RuntimeManagementRoutePage() {
    const context = useOutletContext<ChatProps>();
    return (
        <RuntimeManagementPage
            accessChannelId={context.accessChannelId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
            projectId={context.projectId}
        />
    );
}

function ChannelRouteNotFound() {
    return (
        <ChannelContentError
            message="This route does not identify a page in the paired channel."
            title="Page not found"
        />
    );
}

function AppRoutes() {
    return (
        <Routes>
            <Route element={<PairingPage />} path="/" />
            <Route element={<ChannelRoute />} path="/channels/:channelId">
                <Route element={<ChannelIndexRoute />} index />
                <Route element={<ChannelAccessRoutePage />} path="access" />
                <Route element={<RuntimeManagementRoutePage />} path="runtimes" />
                <Route element={<NewSessionRoute />} path="sessions/new">
                    <Route element={<ConversationRoutePage />} index />
                    <Route element={<AgentSettingsRoutePage />} path="settings" />
                </Route>
                <Route element={<SessionRoute />} path="sessions/:sessionId">
                    <Route element={<ConversationRoutePage />} index />
                    <Route element={<AgentSettingsRoutePage />} path="settings" />
                </Route>
                <Route element={<ChannelRouteNotFound />} path="*" />
            </Route>
            <Route element={<ProjectRuntimeRoute />} path="/projects/:projectId/runtimes/:runtimeId">
                <Route element={<ChannelIndexRoute />} index />
                <Route element={<RuntimeManagementRoutePage />} path="machines" />
                <Route element={<NewSessionRoute />} path="sessions/new">
                    <Route element={<ConversationRoutePage />} index />
                    <Route element={<AgentSettingsRoutePage />} path="settings" />
                </Route>
                <Route element={<SessionRoute />} path="sessions/:sessionId">
                    <Route element={<ConversationRoutePage />} index />
                    <Route element={<AgentSettingsRoutePage />} path="settings" />
                </Route>
                <Route element={<ChannelRouteNotFound />} path="*" />
            </Route>
            <Route
                element={
                    <ChannelErrorPage
                        message="This route does not identify a Mobius channel."
                        title="Channel not found"
                    />
                }
                path="*"
            />
        </Routes>
    );
}

export function App() {
    return (
        <BrowserRouter>
            <AppRoutes />
        </BrowserRouter>
    );
}
