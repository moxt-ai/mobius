import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentInstallationSidebarPanel } from "@/components/agent-installation-panel";
import { ChatComposer } from "@/components/chat-composer";
import { ChatMessageList } from "@/components/chat-message-list";
import { Button } from "@/components/ui/button";
import type { ChannelConnection, ChannelHistory } from "@/domain/channel";
import { PairingApiError } from "@/domain/channel";
import { ChannelHistorySynchronizer } from "@/services/channel-history-synchronizer";
import { closeMobiusTransport, initializeMobiusTransport } from "@/services/mobius-transport";
import { readChannelHistoryForSynchronization } from "@/services/pairing-api";
import { useChatStore } from "@/store/chat-store";

type MobiusChatLoadState =
    | { readonly kind: "loading" }
    | { readonly kind: "failed"; readonly message: string }
    | { readonly kind: "ready"; readonly history: ChannelHistory };

function ChatLoading({ label }: { readonly label: string }) {
    return (
        <div
            role="status"
            aria-label={label}
            className="flex min-h-[560px] flex-1 items-center justify-center text-muted-foreground"
        >
            <LoaderCircle aria-hidden="true" className="size-6 animate-spin motion-reduce:animate-none" />
        </div>
    );
}

function ConnectedMobiusChat({
    connection,
    history,
}: {
    readonly connection: ChannelConnection;
    readonly history: ChannelHistory;
}) {
    const [ready, setReady] = useState(false);
    const agents = useChatStore((state) => state.agents);
    const conversations = useChatStore((state) => state.conversations);
    const activeConversationId = useChatStore((state) => state.activeConversationId);
    const configureChannel = useChatStore((state) => state.configureChannel);
    const createConversation = useChatStore((state) => state.createConversation);
    const runtime = useChatStore((state) => state.runtime);
    const selectConversation = useChatStore((state) => state.selectConversation);
    const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

    useEffect(() => {
        configureChannel(connection, history, "");
        setReady(true);
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
    }, [configureChannel, connection, history]);

    if (ready && agents.length === 0) {
        return (
            <section className="rounded-xl border border-black/10 bg-background p-6">
                <h1 className="text-xl font-semibold">Local Agents</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                    No Agent integration is ready on {connection.machineName} yet. Install Agent CLIs yourself; Mobius
                    can then install and verify their integrations.
                </p>
                {!runtime.canSend && (
                    <p role="status" className="mt-3 text-sm text-muted-foreground">
                        Keep the Mobius daemon online to check Agents and install integrations.
                    </p>
                )}
                <AgentInstallationSidebarPanel />
            </section>
        );
    }

    if (!ready || activeConversation === undefined) {
        return <ChatLoading label="Preparing Mobius chat" />;
    }

    return (
        <div className="flex min-h-[560px] overflow-hidden rounded-xl border border-black/10 bg-background">
            <aside className="w-56 shrink-0 border-r border-black/8 bg-sidebar p-3">
                <div className="px-2 py-2">
                    <p className="truncate text-sm font-semibold">{connection.machineName}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{runtime.label}</p>
                </div>
                <Button className="mt-2 w-full" onClick={createConversation}>
                    New chat
                </Button>
                <nav aria-label="Mobius conversations" className="mt-3 grid gap-1">
                    {conversations.map((conversation) => (
                        <button
                            aria-current={conversation.id === activeConversationId ? "page" : undefined}
                            className="min-h-10 truncate rounded-lg px-3 text-left text-sm hover:bg-black/5 aria-[current=page]:bg-black/8"
                            key={conversation.id}
                            onClick={() => selectConversation(conversation.id)}
                            type="button"
                        >
                            {conversation.title}
                        </button>
                    ))}
                </nav>
            </aside>
            <section className="flex min-w-0 flex-1 flex-col" aria-label="Mobius chat">
                <header className="flex min-h-14 items-center border-b border-black/6 px-4">
                    <h2 className="truncate text-sm font-semibold">{activeConversation.title}</h2>
                </header>
                <ChatMessageList channelId={connection.channelId} />
                {activeConversation.messages.length > 0 && <ChatComposer placement="active" />}
            </section>
        </div>
    );
}

export function MobiusChat({ connection }: { readonly connection: ChannelConnection }) {
    const [state, setState] = useState<MobiusChatLoadState>({ kind: "loading" });

    useEffect(() => {
        const controller = new AbortController();
        setState({ kind: "loading" });
        void readChannelHistoryForSynchronization(connection.channelId, controller.signal)
            .then((history) => {
                if (!controller.signal.aborted) {
                    setState({ kind: "ready", history });
                }
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) {
                    return;
                }
                setState({
                    kind: "failed",
                    message:
                        error instanceof PairingApiError
                            ? `${error.code}: ${error.message}`
                            : "Mobius chat could not be loaded.",
                });
            });
        return () => {
            controller.abort();
        };
    }, [connection]);

    if (state.kind === "loading") {
        return <ChatLoading label="Loading Mobius chat" />;
    }
    if (state.kind === "failed") {
        return <p role="alert">{state.message}</p>;
    }
    return <ConnectedMobiusChat connection={connection} history={state.history} key={connection.channelId} />;
}
