import { CircleAlert, Home, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentInstallationPage } from "@/components/agent-installation-panel";
import { AgentSettingsPage } from "@/components/agent-settings-page";
import { ChatComposer } from "@/components/chat-composer";
import { ChatHeader } from "@/components/chat-header";
import { ChatMessageList } from "@/components/chat-message-list";
import { ConversationSidebar } from "@/components/conversation-sidebar";
import { PairingPage } from "@/components/pairing-page";
import { Button } from "@/components/ui/button";
import type { ChannelConnection, ChannelHistory } from "@/domain/channel";
import { isIdentifier, PairingApiError } from "@/domain/channel";
import { ChannelHistorySynchronizer } from "@/services/channel-history-synchronizer";
import {
  closeMobiusTransport,
  initializeMobiusTransport,
} from "@/services/mobius-transport";
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

function initialSidebarLayout(): DesktopSidebarLayoutState {
  try {
    return decodeSidebarLayoutPreference(
      window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY),
    );
  } catch {
    return decodeSidebarLayoutPreference(null);
  }
}

function ChannelErrorPage({
  message,
  title,
}: {
  readonly message: string;
  readonly title: string;
}) {
  return (
    <main className="flex h-dvh items-center justify-center bg-background p-6">
      <section className="pairing-card w-full max-w-[520px] rounded-2xl bg-white px-8 py-10 text-center">
        <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-[#fff0f0] text-[#b4232a]">
          <CircleAlert className="size-5" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">
          {title}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {message}
        </p>
        <Button className="mt-6" onClick={() => window.location.assign("/")}>
          <Home className="size-4" /> Start a new pairing
        </Button>
      </section>
    </main>
  );
}

abstract class ChannelPage {
  abstract readonly name: string;
}

class ConversationChannelPage extends ChannelPage {
  readonly name = "conversation";
}

class AgentSettingsChannelPage extends ChannelPage {
  readonly name = "agent_settings";
}

function ChannelWorkspace({
  connection,
  history,
  page,
}: {
  readonly connection: ChannelConnection;
  readonly history: ChannelHistory;
  readonly page: ChannelPage;
}) {
  const announcement = useChatStore((state) => state.announcement);
  const activeConversationMessageCount = useChatStore((state) => {
    const conversation = state.conversations.find(
      (candidate) => candidate.id === state.activeConversationId,
    );
    return conversation?.messages.length ?? 0;
  });
  const agents = useChatStore((state) => state.agents);
  const channelConfigured = useChatStore((state) => state.channelConfigured);
  const configureChannel = useChatStore((state) => state.configureChannel);
  const createConversation = useChatStore((state) => state.createConversation);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
  const settingsOpen = page instanceof AgentSettingsChannelPage;
  const channelPath = `/channels/${encodeURIComponent(connection.channelId)}`;
  const [sidebarLayout, setSidebarLayout] =
    useState<DesktopSidebarLayoutState>(initialSidebarLayout);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBAR_LAYOUT_STORAGE_KEY,
        encodeSidebarLayoutPreference(sidebarLayout),
      );
    } catch {}
  }, [sidebarLayout]);

  useEffect(() => {
    configureChannel(connection, history);
    const synchronizer = new ChannelHistorySynchronizer({
      applyHistory: (latestHistory) => {
        useChatStore.getState().reconcileHistory(latestHistory);
      },
      hasActiveTurns: () =>
        useChatStore
          .getState()
          .conversations.some((conversation) => conversation.isRunning),
      readHistory: async (signal) =>
        await readChannelHistoryForSynchronization(
          connection.channelId,
          signal,
        ),
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
  }, [configureChannel, connection, history]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
        return;
      }
      if (
        event.key.toLowerCase() === "n" &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        createConversation();
        if (settingsOpen) {
          window.location.assign(channelPath);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [channelPath, createConversation, setSidebarOpen, settingsOpen]);

  if (!channelConfigured) {
    return <ChannelLoadingPage />;
  }
  if (agents.length === 0 && page instanceof ConversationChannelPage) {
    return <AgentInstallationPage channelId={connection.channelId} />;
  }

  return (
    <>
      <a
        className="fixed top-3 left-3 z-50 -translate-y-[180%] rounded-lg bg-[#2fb872] px-[13px] py-[9px] text-[13px] font-semibold text-[#062f1c] no-underline transition-transform duration-150 motion-reduce:transition-none focus:translate-y-0"
        href="#main-content"
      >
        {settingsOpen ? "Skip to Agent settings" : "Skip to conversation"}
      </a>
      <div className="flex h-dvh w-full bg-background">
        <ConversationSidebar
          channelId={connection.channelId}
          layout={sidebarLayout}
          onLayoutChange={setSidebarLayout}
          settingsOpen={settingsOpen}
        />
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
          id="main-content"
        >
          {settingsOpen ? (
            <AgentSettingsPage
              channelId={connection.channelId}
              desktopSidebarCollapsed={sidebarLayout.kind === "collapsed"}
              onToggleDesktopSidebar={() => {
                setSidebarLayout((current) => toggleSidebar(current));
              }}
            />
          ) : (
            <>
              <ChatHeader
                desktopSidebarCollapsed={sidebarLayout.kind === "collapsed"}
                onToggleDesktopSidebar={() => {
                  setSidebarLayout((current) => toggleSidebar(current));
                }}
              />
              <section
                aria-label="Agent conversation"
                className="flex min-h-0 flex-1 flex-col"
              >
                <ChatMessageList channelId={connection.channelId} />
                {activeConversationMessageCount > 0 && (
                  <ChatComposer placement="active" />
                )}
                <p aria-live="polite" className="sr-only">
                  {announcement}
                </p>
              </section>
            </>
          )}
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

function ChannelLoadingPage() {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className="flex h-dvh items-center justify-center bg-background p-6"
    >
      <section className="pairing-card w-full max-w-[520px] rounded-2xl bg-white px-8 py-10 text-center">
        <LoaderCircle className="mx-auto size-6 animate-spin text-[#279a60]" />
        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">
          Opening channel
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Loading the paired local machine from the relay.
        </p>
      </section>
    </main>
  );
}

function ChannelRoute({
  channelId,
  page,
}: {
  readonly channelId: string;
  readonly page: ChannelPage;
}) {
  const [state, setState] = useState<ChannelRouteState>(
    new LoadingChannelRouteState(),
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        await redeemChannelAccessGrantFromLocation(
          channelId,
          controller.signal,
        );
        const [connection, history] = await Promise.all([
          readChannelConnection(channelId),
          readChannelHistory(channelId),
        ]);
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

  if (state instanceof ReadyChannelRouteState) {
    return (
      <ChannelWorkspace
        connection={state.connection}
        history={state.history}
        page={page}
      />
    );
  }
  if (state instanceof FailedChannelRouteState) {
    return (
      <ChannelErrorPage message={state.message} title="Channel unavailable" />
    );
  }
  return <ChannelLoadingPage />;
}

export function App() {
  if (window.location.pathname === "/") {
    return <PairingPage />;
  }

  const match = /^\/channels\/([^/]+)(?:\/(settings))?\/?$/.exec(
    window.location.pathname,
  );
  if (match === null) {
    return (
      <ChannelErrorPage
        message="This route does not identify a Mobius channel."
        title="Channel not found"
      />
    );
  }

  let channelId = "";
  try {
    channelId = decodeURIComponent(match[1] ?? "");
  } catch {
    return (
      <ChannelErrorPage
        message="The channel route is malformed."
        title="Invalid channel"
      />
    );
  }
  if (!isIdentifier(channelId)) {
    return (
      <ChannelErrorPage
        message="The channel route is malformed."
        title="Invalid channel"
      />
    );
  }

  const page =
    match[2] === "settings"
      ? new AgentSettingsChannelPage()
      : new ConversationChannelPage();

  return <ChannelRoute channelId={channelId} page={page} />;
}
