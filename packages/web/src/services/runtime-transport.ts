import { mobiusApiUrl } from "@moxt-ai/mobius-sdk";
import { connectMobiusChannelClient, type MobiusChannelClient } from "@moxt-ai/mobius-sdk/channel";
import {
    CancelledAgentInstallationState,
    type ChannelConnection,
    FailedAgentInstallationState,
    ProjectRuntimeCredentialAuthority,
    RequestingAgentInstallationState,
    RunningAgentInstallationState,
    StartingAgentInstallationState,
    SucceededAgentInstallationState,
} from "@/domain/channel";
import {
    ConnectingRuntimeState,
    OfflineRuntimeState,
    OnlineRuntimeState,
    ReconnectingRuntimeState,
    UnavailableRuntimeState,
} from "@/domain/runtime";
import { readChannelConnection, readProjectRuntimeConnection } from "@/services/pairing-api";
import { useRuntimeStore } from "@/store/runtime-store";

interface RuntimeTransport {
    readonly controller: AbortController;
    readonly client: Promise<MobiusChannelClient>;
}
let transport: RuntimeTransport | null = null;
export function initializeRuntimeTransport(connection: ChannelConnection): () => void {
    const controller = new AbortController();
    const signal = controller.signal;
    const store = useRuntimeStore.getState();
    store.reset();
    store.configure(connection);
    store.setRuntime(new ConnectingRuntimeState());
    const refresh = async (): Promise<void> => {
        try {
            const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
            const latest =
                connection.credentialAuthority instanceof ProjectRuntimeCredentialAuthority
                    ? await readProjectRuntimeConnection(
                          connection.projectId,
                          connection.runtimeId,
                          deadline,
                          connection.accessChannelId,
                      )
                    : await readChannelConnection(connection.channelId, deadline);
            signal.throwIfAborted();
            useRuntimeStore.getState().configure(latest);
        } catch {
            if (!signal.aborted) {
                useRuntimeStore.getState().setRuntime(new UnavailableRuntimeState());
            }
        }
    };
    const apply = (installation: Parameters<typeof store.installationChanged>[0]): void => {
        if (!signal.aborted) {
            useRuntimeStore.getState().installationChanged(installation);
        }
    };
    const client = connectMobiusChannelClient({
        relayUrl: async (connectionSignal) => {
            signal.throwIfAborted();
            connectionSignal.throwIfAborted();
            const path: `/${string}` =
                connection.credentialAuthority instanceof ProjectRuntimeCredentialAuthority
                    ? `/projects/${encodeURIComponent(connection.projectId)}/runtimes/${encodeURIComponent(connection.runtimeId)}/host`
                    : `/channels/${encodeURIComponent(connection.accessChannelId)}/host`;
            const url = mobiusApiUrl(window.location.origin, path);
            url.searchParams.set("token", connection.hostToken);
            url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            return url.toString();
        },
        onInstallStarted: (event) => apply(new StartingAgentInstallationState(event.agentId, event.requestId)),
        onInstallProgress: (event) =>
            apply(new RunningAgentInstallationState(event.agentId, event.requestId, event.stage)),
        onInstallCompleted: (event) => {
            apply(
                new SucceededAgentInstallationState(event.agentId, event.requestId, event.authenticationMayBeRequired),
            );
            void refresh();
        },
        onInstallFailed: (event) => {
            apply(new FailedAgentInstallationState(event.agentId, event.requestId, event.code, event.message));
            void refresh();
        },
        onInstallCancelled: (event) => apply(new CancelledAgentInstallationState(event.agentId, event.requestId)),
        onStatus: (online) => {
            if (!signal.aborted) {
                store.setRuntime(online ? new OnlineRuntimeState() : new OfflineRuntimeState());
                if (online) {
                    void refresh();
                }
            }
        },
        onReconnecting: () => {
            if (!signal.aborted) {
                store.setRuntime(new ReconnectingRuntimeState());
            }
        },
        onUnavailable: () => {
            if (!signal.aborted) {
                store.setRuntime(new UnavailableRuntimeState());
            }
        },
    });
    const current = { client, controller };
    transport = current;
    void client.then(
        (connected) => {
            if (signal.aborted) {
                connected.close();
            }
        },
        () => {
            if (!signal.aborted) {
                store.setRuntime(new UnavailableRuntimeState());
            }
        },
    );
    return () => {
        controller.abort();
        if (transport === current) {
            transport = null;
        }
        void client.then(
            (connected) => connected.close(),
            () => undefined,
        );
    };
}
export async function recheckLocalAgents(): Promise<void> {
    const current = transport;
    if (current === null) {
        return;
    }
    const client = await current.client;
    current.controller.signal.throwIfAborted();
    await Promise.all(
        useRuntimeStore.getState().installableAgents.map(async (agent) => {
            if (
                useRuntimeStore
                    .getState()
                    .agentInstallations.some((item) => item.agentId === agent.id && item.canCancel)
            ) {
                return;
            }
            const requestId = crypto.randomUUID();
            useRuntimeStore.getState().installationChanged(new RequestingAgentInstallationState(agent.id, requestId));
            try {
                await client.installAgent({ agentId: agent.id, requestId });
            } catch {
                if (!current.controller.signal.aborted) {
                    useRuntimeStore
                        .getState()
                        .installationChanged(
                            new FailedAgentInstallationState(
                                agent.id,
                                requestId,
                                "installation_failed",
                                "The Agent integration could not be checked.",
                            ),
                        );
                }
            }
        }),
    );
}
export async function closeRuntimeTransport(): Promise<void> {
    const current = transport;
    transport = null;
    if (current !== null) {
        current.controller.abort();
        try {
            (await current.client).close();
        } catch {
            /* Connection already unavailable. */
        }
    }
}
