import { CircleAlert, Home, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    BrowserRouter,
    Navigate,
    Outlet,
    Route,
    Routes,
    useLocation,
    useMatch,
    useNavigate,
    useOutletContext,
    useParams,
} from "react-router";
import { AgentInstallationPage } from "@/components/agent-installation-panel";
import { AgentSettingsPage } from "@/components/agent-settings-page";
import { BotConnectionsPage } from "@/components/bots/bot-connections-page";
import { BotConversationPage, BotConversationsPage } from "@/components/bots/bot-conversations-page";
import { BotDirectoryPage } from "@/components/bots/bot-directory-page";
import { BotOverviewPage } from "@/components/bots/bot-overview-page";
import { BotWorkspace } from "@/components/bots/bot-workspace";
import { ChannelAccessPage } from "@/components/channel-access-panel";
import { ChatComposer } from "@/components/chat-composer";
import { ChatHeader } from "@/components/chat-header";
import { ChatMessageList } from "@/components/chat-message-list";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { ConversationTargetProvider } from "@/components/conversation-target-provider";
import { PairingPage } from "@/components/pairing-page";
import { RuntimeManagementPage } from "@/components/runtime-management-page";
import { Button } from "@/components/ui/button";
import type { ChannelConnection, ChannelHistory } from "@/domain/channel";
import { isIdentifier, PairingApiError } from "@/domain/channel";
import {
    botConversationRoutePath,
    channelRoutePath,
    sessionRoutePath,
    sessionSettingsRoutePath,
} from "@/services/app-routes";
import { ChannelHistorySynchronizer } from "@/services/channel-history-synchronizer";
import { closeMobiusTransport, initializeMobiusTransport } from "@/services/mobius-transport";
import {
    readChannelConnection,
    readChannelHistory,
    readChannelHistoryForSynchronization,
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
    readonly channelId: string;
    readonly connection: ChannelConnection;
    readonly desktopSidebarCollapsed: boolean;
    readonly onCreateConversation: () => void;
    readonly onToggleDesktopSidebar: () => void;
    readonly projectId: string;
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
    const { channelId } = useOutletContext<ChatProps>();
    const navigate = useNavigate();
    return (
        <section className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="w-full max-w-[520px] text-center">
                <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#b4232a]">
                    <CircleAlert className="size-5" />
                </span>
                <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">{title}</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{message}</p>
                <Button className="mt-6" onClick={() => navigate(channelRoutePath(channelId), { replace: true })}>
                    Return to channel
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
                <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">Opening channel</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Loading the paired local machine from the relay.
                </p>
            </section>
        </main>
    );
}

function ChannelWorkspace({
    connection,
    history,
}: {
    readonly connection: ChannelConnection;
    readonly history: ChannelHistory;
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
    const channelIndexMatch = useMatch("/channels/:channelId");
    const accessOpen = useMatch("/channels/:channelId/access") !== null;
    const runtimesOpen = useMatch("/channels/:channelId/runtimes") !== null;
    const legacySettingsMatch = useMatch("/channels/:channelId/settings");
    const sessionSettingsMatch = useMatch("/channels/:channelId/sessions/:sessionId/settings");
    const settingsOpen = legacySettingsMatch !== null || sessionSettingsMatch !== null;
    const botDirectoryOpen = useMatch("/channels/:channelId/bots") !== null;
    const botDetailOpen = useMatch("/channels/:channelId/bots/*") !== null;
    const botsOpen = botDirectoryOpen || botDetailOpen;
    const managementPageOpen = accessOpen || runtimesOpen || settingsOpen || botsOpen;
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
            readHistory: async (signal) => await readChannelHistoryForSynchronization(connection.channelId, signal),
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
        for (const conversation of store.conversations) {
            if (conversation.id === store.activeConversationId) {
                void navigate(sessionRoutePath(connection.channelId, conversation.sessionId));
                return;
            }
        }
    }, [connection.channelId, createConversation, navigate]);

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
    if (agents.length === 0 && channelIndexMatch !== null) {
        return <AgentInstallationPage channelId={connection.channelId} />;
    }

    const context: ChatProps = {
        channelId: connection.channelId,
        connection,
        desktopSidebarCollapsed: sidebarLayout.kind === "collapsed",
        onCreateConversation: createAndOpenConversation,
        onToggleDesktopSidebar: () => {
            setSidebarLayout((current) => toggleSidebar(current));
        },
        projectId: connection.projectId,
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
                        : botsOpen
                          ? "Skip to Bot management"
                          : "Skip to conversation"}
            </a>
            <div className="flex h-dvh w-full bg-background">
                <ConversationSidebar
                    channelId={connection.channelId}
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
                const connection = await readChannelConnection(channelId);
                const history = await readChannelHistory(channelId);
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
        return (
            <ChannelWorkspace connection={state.connection} history={state.history} key={state.connection.channelId} />
        );
    }
    if (state instanceof FailedChannelRouteState) {
        return <ChannelErrorPage message={state.message} title="Channel unavailable" />;
    }
    return <ChannelLoadingPage />;
}

function ChannelIndexRoute() {
    const { channelId } = useOutletContext<ChatProps>();
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const conversations = useChatStore((state) => state.conversations);
    const sessionId = conversations.find((conversation) => conversation.id === activeConversationId)?.sessionId;
    if (sessionId === undefined) {
        return (
            <ChannelContentError message="This channel does not have a Session to open." title="Session unavailable" />
        );
    }
    return <Navigate replace to={sessionRoutePath(channelId, sessionId)} />;
}

function LegacyAgentSettingsRoute() {
    const context = useOutletContext<ChatProps>();
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const conversations = useChatStore((state) => state.conversations);
    const sessionId = conversations.find((conversation) => conversation.id === activeConversationId)?.sessionId;
    if (sessionId !== undefined) {
        return <Navigate replace to={sessionSettingsRoutePath(context.channelId, sessionId)} />;
    }
    return <AgentSettingsRoutePage />;
}

function SessionRoute() {
    const context = useOutletContext<ChatProps>();
    const params = useParams<"sessionId">();
    const sessionId = params.sessionId ?? "";
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const conversations = useChatStore((state) => state.conversations);
    const selectConversation = useChatStore((state) => state.selectConversation);
    const conversation = conversations.find((candidate) => candidate.sessionId === sessionId);

    useLayoutEffect(() => {
        if (conversation !== undefined && conversation.id !== activeConversationId) {
            selectConversation(conversation.id);
        }
    }, [activeConversationId, conversation, selectConversation]);

    if (!isIdentifier(sessionId)) {
        return <ChannelContentError message="The Session route is malformed." title="Invalid Session" />;
    }
    if (conversation === undefined) {
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
    return <Outlet context={context} />;
}

export function Chat({ channelId, desktopSidebarCollapsed, onCreateConversation, onToggleDesktopSidebar }: ChatProps) {
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
                <ChatMessageList channelId={channelId} />
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
    const navigate = useNavigate();
    const openBotConversation = useCallback(
        (botId: string, conversationId: string): void => {
            void navigate(botConversationRoutePath(context.channelId, botId, conversationId));
        },
        [context.channelId, navigate],
    );
    return (
        <ConversationTargetProvider connection={context.connection} onOpenBotConversation={openBotConversation}>
            <Chat {...context} />
        </ConversationTargetProvider>
    );
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
            channelId={context.channelId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
        />
    );
}

function RuntimeManagementRoutePage() {
    const context = useOutletContext<ChatProps>();
    return (
        <RuntimeManagementPage
            channelId={context.channelId}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
            projectId={context.projectId}
        />
    );
}

function BotDirectoryRoutePage() {
    const context = useOutletContext<ChatProps>();
    return (
        <BotDirectoryPage
            connection={context.connection}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            key={context.channelId}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
        />
    );
}

function BotWorkspaceRoutePage() {
    const context = useOutletContext<ChatProps>();
    const params = useParams<"botId">();
    return (
        <BotWorkspace
            connection={context.connection}
            desktopSidebarCollapsed={context.desktopSidebarCollapsed}
            key={`${context.channelId}:${params.botId ?? ""}`}
            onToggleDesktopSidebar={context.onToggleDesktopSidebar}
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
                <Route element={<BotDirectoryRoutePage />} path="bots" />
                <Route element={<BotWorkspaceRoutePage />} path="bots/:botId">
                    <Route element={<BotOverviewPage />} index />
                    <Route element={<BotConversationsPage />} path="conversations" />
                    <Route element={<BotConversationPage />} path="conversations/:conversationId" />
                    <Route element={<BotConnectionsPage />} path="connections" />
                </Route>
                <Route element={<LegacyAgentSettingsRoute />} path="settings" />
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
