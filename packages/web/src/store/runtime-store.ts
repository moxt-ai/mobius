import { create } from "zustand";
import type {
    AgentInstallationViewState,
    AgentOption,
    ChannelConnection,
    InstallableAgentOption,
} from "@/domain/channel";
import { ConnectingRuntimeState, type RuntimeConnectionState } from "@/domain/runtime";

interface RuntimeState {
    readonly agents: readonly AgentOption[];
    readonly installableAgents: readonly InstallableAgentOption[];
    readonly agentInstallations: readonly AgentInstallationViewState[];
    readonly machineName: string;
    readonly runtime: RuntimeConnectionState;
    readonly sidebarOpen: boolean;
    readonly setSidebarOpen: (open: boolean) => void;
    readonly configure: (connection: ChannelConnection) => void;
    readonly reset: () => void;
    readonly setRuntime: (runtime: RuntimeConnectionState) => void;
    readonly installationChanged: (installation: AgentInstallationViewState) => void;
}
export const useRuntimeStore = create<RuntimeState>((set) => ({
    agents: [],
    installableAgents: [],
    agentInstallations: [],
    machineName: "",
    runtime: new ConnectingRuntimeState(),
    sidebarOpen: false,
    setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    configure: (connection) =>
        set({
            agents: connection.agents,
            installableAgents: connection.installableAgents,
            machineName: connection.machineName,
        }),
    reset: () =>
        set({
            agents: [],
            installableAgents: [],
            agentInstallations: [],
            machineName: "",
            sidebarOpen: false,
            runtime: new ConnectingRuntimeState(),
        }),
    setRuntime: (runtime) => set({ runtime }),
    installationChanged: (installation) =>
        set((state) => ({
            agentInstallations: [
                ...state.agentInstallations.filter((item) => item.agentId !== installation.agentId),
                installation,
            ],
        })),
}));
