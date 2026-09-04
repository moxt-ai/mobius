import { CircleAlert, Home, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

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
} from "@/services/pairing-api";
import { useChatStore } from "@/store/chat-store";

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

function ChannelWorkspace({
  connection,
  history,
}: {
  readonly connection: ChannelConnection;
  readonly history: ChannelHistory;
}) {
  const announcement = useChatStore((state) => state.announcement);
  const configureChannel = useChatStore((state) => state.configureChannel);
  const createConversation = useChatStore((state) => state.createConversation);
  const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);

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
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [createConversation, setSidebarOpen]);

  return (
    <>
      <a
        className="fixed top-3 left-3 z-50 -translate-y-[180%] rounded-lg bg-[#2fb872] px-[13px] py-[9px] text-[13px] font-semibold text-[#062f1c] no-underline transition-transform duration-150 focus:translate-y-0"
        href="#main-content"
      >
        Skip to conversation
      </a>
      <div className="grid h-dvh w-full grid-cols-1 bg-background md:grid-cols-[264px_minmax(0,1fr)]">
        <ConversationSidebar />
        <main
          className="flex min-h-0 min-w-0 flex-col bg-background"
          id="main-content"
        >
          <ChatHeader />
          <section
            aria-label="Agent conversation"
            className="flex min-h-0 flex-1 flex-col"
          >
            <ChatMessageList />
            <ChatComposer />
            <p aria-live="polite" className="sr-only">
              {announcement}
            </p>
          </section>
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

function ChannelRoute({ channelId }: { readonly channelId: string }) {
  const [state, setState] = useState<ChannelRouteState>(
    new LoadingChannelRouteState(),
  );

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
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
    };
  }, [channelId]);

  if (state instanceof ReadyChannelRouteState) {
    return (
      <ChannelWorkspace connection={state.connection} history={state.history} />
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

  const match = /^\/channels\/([^/]+)$/.exec(window.location.pathname);
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

  return <ChannelRoute channelId={channelId} />;
}
