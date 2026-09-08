import { Bot, Cable, CheckCircle2, CircleAlert, LoaderCircle, Settings, X } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import {
    type AgentInstallationViewState,
    AgentIntegrationOption,
    FailedAgentInstallationState,
    IdleAgentInstallationState,
    type InstallableAgentOption,
    MissingAgentOption,
    SucceededAgentInstallationState,
} from "@/domain/channel";
import { channelSettingsRoutePath } from "@/services/app-routes";
import { cancelLocalAgentInstallation, installLocalAgent } from "@/services/mobius-transport";
import { useChatStore } from "@/store/chat-store";

interface AgentInstallationCardsViewProps {
    readonly agents: readonly InstallableAgentOption[];
    readonly compact: boolean;
    readonly installations: readonly AgentInstallationViewState[];
    readonly onCancel: (agentId: string) => void;
    readonly onInstall: (agentId: string) => void;
    readonly runtimeCanSend: boolean;
}

export function AgentInstallationCardsView({
    agents,
    compact,
    installations,
    onCancel,
    onInstall,
    runtimeCanSend,
}: AgentInstallationCardsViewProps) {
    return (
        <div className={compact ? "space-y-2" : "mt-7 grid gap-3 sm:grid-cols-2"}>
            {agents.map((agent) => {
                const installation = installations.find((candidate) => candidate.agentId === agent.id);
                const succeeded = installation instanceof SucceededAgentInstallationState;
                const failed = installation instanceof FailedAgentInstallationState;
                const active = installation?.canCancel === true;
                const missing = agent instanceof MissingAgentOption;
                if (!missing && !(agent instanceof AgentIntegrationOption)) {
                    throw new Error("Unsupported local Agent integration option");
                }
                return (
                    <article
                        className={
                            compact
                                ? "rounded-[10px] border-[0.5px] border-black/9 bg-white p-2.5"
                                : "rounded-xl border-[0.5px] border-black/10 bg-white p-4 text-left shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                        }
                        key={agent.id}
                    >
                        <div className="flex items-start gap-2.5">
                            <span
                                className={
                                    missing
                                        ? "mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[#fff7e8] text-[#a85d00]"
                                        : "mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#218854]"
                                }
                            >
                                {active ? (
                                    <LoaderCircle
                                        aria-hidden="true"
                                        className="size-4 animate-spin motion-reduce:animate-none"
                                    />
                                ) : succeeded ? (
                                    <CheckCircle2 aria-hidden="true" className="size-4" />
                                ) : failed ? (
                                    <CircleAlert aria-hidden="true" className="size-4 text-[#b4232a]" />
                                ) : (
                                    <Cable aria-hidden="true" className="size-4" />
                                )}
                            </span>
                            <span className="min-w-0 flex-1">
                                <strong className="block text-[13px] leading-5 font-semibold">{agent.label}</strong>
                                <span
                                    className={
                                        missing
                                            ? "mt-0.5 block text-[11px] leading-4 font-medium text-[#a85d00]"
                                            : "mt-0.5 block text-[11px] leading-4 font-medium text-[#218854]"
                                    }
                                >
                                    {missing ? "Not installed" : "Agent detected"}
                                </span>
                            </span>
                        </div>
                        {agent instanceof AgentIntegrationOption && (
                            <dl className="mt-3 grid gap-2 rounded-lg bg-black/[0.025] p-3 text-[11px] leading-4">
                                <div className="min-w-0">
                                    <dt className="font-medium text-muted-foreground">Version</dt>
                                    <dd className="mt-0.5 break-words text-foreground">{agent.agentVersion}</dd>
                                </div>
                                <div className="min-w-0">
                                    <dt className="font-medium text-muted-foreground">Path</dt>
                                    <dd className="mt-0.5 break-all font-mono text-foreground">{agent.agentPath}</dd>
                                </div>
                            </dl>
                        )}
                        <p
                            aria-live={failed ? "polite" : undefined}
                            className="mt-3 text-[11px] leading-4 text-muted-foreground"
                        >
                            {installation !== undefined && !(installation instanceof IdleAgentInstallationState)
                                ? installation.message
                                : missing
                                  ? `Install ${agent.label} on this machine first. Then Mobius can install and verify its integration.`
                                  : "The Agent is installed locally. Install its Mobius integration to make it available in chat."}
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                            {active ? (
                                <Button
                                    className="min-h-11 px-3 text-xs"
                                    onClick={() => onCancel(agent.id)}
                                    variant="outline"
                                >
                                    <X aria-hidden="true" className="size-3.5" /> Cancel
                                </Button>
                            ) : (
                                <Button
                                    className="min-h-11 px-3 text-xs"
                                    disabled={!runtimeCanSend || succeeded}
                                    onClick={() => onInstall(agent.id)}
                                >
                                    <Cable aria-hidden="true" className="size-3.5" />
                                    {failed ? "Retry integration" : succeeded ? "Ready" : "Install integration"}
                                </Button>
                            )}
                        </div>
                    </article>
                );
            })}
        </div>
    );
}

function AgentInstallationCards({ compact }: { readonly compact: boolean }) {
    const agents = useChatStore((state) => state.installableAgents);
    const installations = useChatStore((state) => state.agentInstallations);
    const runtime = useChatStore((state) => state.runtime);
    return (
        <AgentInstallationCardsView
            agents={agents}
            compact={compact}
            installations={installations}
            onCancel={(agentId) => void cancelLocalAgentInstallation(agentId)}
            onInstall={(agentId) => void installLocalAgent(agentId)}
            runtimeCanSend={runtime.canSend}
        />
    );
}

export function AgentInstallationSidebarPanel() {
    const installableAgents = useChatStore((state) => state.installableAgents);
    if (installableAgents.length === 0) {
        return null;
    }
    return (
        <section className="border-t-[0.5px] border-black/6 px-3 py-3">
            <h2 className="mb-2 px-1 text-[11px] font-semibold tracking-[0.02em] text-muted-foreground">
                Agent integrations
            </h2>
            <AgentInstallationCards compact />
        </section>
    );
}

export function AgentInstallationPage({ channelId }: { readonly channelId: string }) {
    const machineName = useChatStore((state) => state.machineName);
    const runtime = useChatStore((state) => state.runtime);
    return (
        <main className="flex min-h-dvh overflow-y-auto bg-background p-4 sm:p-6">
            <section className="pairing-card mx-auto my-auto w-full max-w-[720px] rounded-2xl bg-white px-5 py-7 text-center sm:px-10 sm:py-9">
                <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-[#eefaf3] text-[#218854]">
                    <Bot aria-hidden="true" className="size-5" />
                </span>
                <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em]">Local Agents</h1>
                <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                    No Agent integration is ready on {machineName} yet. Install Agent CLIs yourself; Mobius can then
                    install and verify their integrations.
                </p>
                {!runtime.canSend && (
                    <p className="mt-3 text-xs font-medium text-[#a85d00]">
                        Keep the Mobius daemon online to check Agents and install integrations.
                    </p>
                )}
                <AgentInstallationCards compact={false} />
                <p className="mt-6 text-xs leading-5 text-muted-foreground">
                    Each request rechecks the local machine, so an Agent installed after the daemon started can be
                    detected without pairing again. Provider sign-in may still be required afterward.
                </p>
                <Link
                    className="mx-auto mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs font-medium text-muted-foreground no-underline transition-colors duration-150 hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    to={channelSettingsRoutePath(channelId)}
                >
                    <Settings aria-hidden="true" className="size-3.5" />
                    Open Agent settings
                </Link>
            </section>
        </main>
    );
}
