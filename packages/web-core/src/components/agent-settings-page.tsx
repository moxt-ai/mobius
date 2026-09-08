import { ArrowLeft, Bot, CheckCircle2, Menu, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import { AgentInstallationCardsView } from "@/components/agent-installation-panel";
import { Button } from "@/components/ui/button";
import type { AgentInstallationViewState, AgentOption, InstallableAgentOption } from "@/domain/channel";
import { cancelLocalAgentInstallation, installLocalAgent } from "@/services/mobius-transport";
import { useChatStore } from "@/store/chat-store";

function countLabel(count: number, singular: string): string {
    return `${count.toString()} ${count === 1 ? singular : `${singular}s`}`;
}

interface AgentSettingsViewProps {
    readonly agents: readonly AgentOption[];
    readonly desktopSidebarCollapsed: boolean;
    readonly installableAgents: readonly InstallableAgentOption[];
    readonly installations: readonly AgentInstallationViewState[];
    readonly machineName: string;
    readonly onCancelInstallation: (agentId: string) => void;
    readonly onInstall: (agentId: string) => void;
    readonly onOpenSidebar: () => void;
    readonly onToggleDesktopSidebar: () => void;
    readonly runtimeCanSend: boolean;
    readonly runtimeLabel: string;
    readonly sidebarOpen: boolean;
}

function AgentSettingsView({
    agents,
    desktopSidebarCollapsed,
    installableAgents,
    installations,
    machineName,
    onCancelInstallation,
    onInstall,
    onOpenSidebar,
    onToggleDesktopSidebar,
    runtimeCanSend,
    runtimeLabel,
    sidebarOpen,
}: AgentSettingsViewProps) {
    return (
        <>
            <header className="chat-header z-10 flex shrink-0 items-center border-b-[0.5px] border-black/6 bg-background/92 px-2.5 supports-[backdrop-filter]:backdrop-blur-xl md:px-[18px]">
                <Button
                    aria-controls="conversation-sidebar"
                    aria-expanded={sidebarOpen}
                    aria-label="Open conversation sidebar"
                    className="mr-[7px] size-11 lg:hidden"
                    id="conversation-sidebar-trigger"
                    onClick={onOpenSidebar}
                    size="icon"
                    variant="ghost"
                >
                    <Menu aria-hidden="true" className="size-[18px]" />
                </Button>
                <Button
                    aria-label={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    className="mr-2 hidden lg:inline-flex"
                    onClick={onToggleDesktopSidebar}
                    size="icon"
                    title={desktopSidebarCollapsed ? "Show conversation sidebar" : "Hide conversation sidebar"}
                    variant="ghost"
                >
                    {desktopSidebarCollapsed ? (
                        <PanelLeftOpen aria-hidden="true" className="size-4" />
                    ) : (
                        <PanelLeftClose aria-hidden="true" className="size-4" />
                    )}
                </Button>
                <span className="inline-flex size-8 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#218854]">
                    <Settings aria-hidden="true" className="size-4" />
                </span>
                <h1 className="ml-2 text-sm font-semibold tracking-[-0.01em]">Agent settings</h1>
                <Link
                    className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-muted-foreground no-underline transition-colors duration-150 hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    relative="path"
                    to=".."
                >
                    <ArrowLeft aria-hidden="true" className="size-3.5" />
                    Back to chat
                </Link>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-[920px] px-5 py-8 sm:px-8 sm:py-10">
                    <section aria-labelledby="local-agents-heading">
                        <p className="text-[11px] font-semibold tracking-[0.08em] text-[#218854] uppercase">
                            Local machine
                        </p>
                        <h2
                            className="mt-2 text-[28px] leading-9 font-semibold tracking-[-0.035em]"
                            id="local-agents-heading"
                        >
                            Local Agents
                        </h2>
                        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                            See which Agent CLIs Mobius detected on {machineName}, including their reported version and
                            executable path. Mobius installs only the integration; Agent installation and sign-in remain
                            local actions.
                        </p>

                        <div className="mt-6 grid gap-3 sm:grid-cols-3">
                            <div className="rounded-xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                                <span className="text-[11px] font-medium text-muted-foreground">Access</span>
                                <strong className="mt-1 block text-sm font-semibold">Local OS user</strong>
                            </div>
                            <div className="rounded-xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                                <span className="text-[11px] font-medium text-muted-foreground">Verified</span>
                                <strong className="mt-1 block text-sm font-semibold">
                                    {countLabel(agents.length, "Agent")}
                                </strong>
                            </div>
                            <div className="rounded-xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                                <span className="text-[11px] font-medium text-muted-foreground">Local daemon</span>
                                <strong
                                    aria-live="polite"
                                    className={
                                        runtimeCanSend
                                            ? "mt-1 block text-sm font-semibold text-[#218854]"
                                            : "mt-1 block text-sm font-semibold text-[#a85d00]"
                                    }
                                >
                                    {runtimeLabel}
                                </strong>
                            </div>
                        </div>
                    </section>

                    <section aria-labelledby="ready-agents-heading" className="mt-10">
                        <div className="flex items-end justify-between gap-4">
                            <div>
                                <h2 className="text-base font-semibold tracking-[-0.015em]" id="ready-agents-heading">
                                    Ready to use
                                </h2>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                    These complete Agent and ACP paths passed local verification.
                                </p>
                            </div>
                            <span className="shrink-0 rounded-full bg-[#eefaf3] px-2.5 py-1 text-[11px] font-semibold text-[#218854]">
                                {countLabel(agents.length, "integration")}
                            </span>
                        </div>

                        {agents.length > 0 ? (
                            <ul aria-label="Verified local Agents" className="mt-4 grid gap-3 sm:grid-cols-2">
                                {agents.map((agent) => (
                                    <li
                                        className="rounded-xl border-[0.5px] border-black/10 bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
                                        key={agent.id}
                                    >
                                        <div className="flex items-start gap-3">
                                            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[#eefaf3] text-[#218854]">
                                                <Bot aria-hidden="true" className="size-[18px]" />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <strong className="block truncate text-sm font-semibold">
                                                    {agent.label}
                                                </strong>
                                                <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-[#218854]">
                                                    <CheckCircle2 aria-hidden="true" className="size-3.5" />
                                                    Ready
                                                </span>
                                            </span>
                                        </div>
                                        <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                            The local Agent CLI and its ACP connection are verified for this channel.
                                        </p>
                                        <dl className="mt-3 grid gap-2 rounded-lg bg-black/[0.025] p-3 text-[11px] leading-4">
                                            <div className="min-w-0">
                                                <dt className="font-medium text-muted-foreground">Version</dt>
                                                <dd className="mt-0.5 break-words text-foreground">
                                                    {agent.agentVersion}
                                                </dd>
                                            </div>
                                            <div className="min-w-0">
                                                <dt className="font-medium text-muted-foreground">Path</dt>
                                                <dd className="mt-0.5 break-all font-mono text-foreground">
                                                    {agent.agentPath}
                                                </dd>
                                            </div>
                                        </dl>
                                        <Link
                                            className="mt-3 inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-medium text-foreground no-underline transition-colors duration-150 hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                                            relative="path"
                                            to=".."
                                        >
                                            Use in chat
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <div className="mt-4 rounded-xl border border-dashed border-black/15 bg-white/60 px-5 py-6 text-sm text-muted-foreground">
                                No local Agent has passed the complete ACP check yet.
                            </div>
                        )}
                    </section>

                    <section aria-labelledby="available-agents-heading" className="mt-10">
                        <div className="flex items-end justify-between gap-4">
                            <div>
                                <h2
                                    className="text-base font-semibold tracking-[-0.015em]"
                                    id="available-agents-heading"
                                >
                                    Needs setup
                                </h2>
                                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                                    Missing Agents must be installed locally first. Mobius can install or repair only
                                    their ACP integrations.
                                </p>
                            </div>
                            <span className="shrink-0 rounded-full bg-black/5 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">
                                {countLabel(installableAgents.length, "integration")}
                            </span>
                        </div>

                        {installableAgents.length > 0 ? (
                            <AgentInstallationCardsView
                                agents={installableAgents}
                                compact={false}
                                installations={installations}
                                onCancel={onCancelInstallation}
                                onInstall={onInstall}
                                runtimeCanSend={runtimeCanSend}
                            />
                        ) : (
                            <div className="mt-4 flex items-start gap-3 rounded-xl border-[0.5px] border-black/10 bg-white px-5 py-4 shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                                <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-[#eefaf3] text-[#218854]">
                                    <ShieldCheck aria-hidden="true" className="size-4" />
                                </span>
                                <span>
                                    <strong className="block text-sm font-semibold">
                                        All detected Agent integrations are ready
                                    </strong>
                                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                                        No integration installation or recovery action is currently needed.
                                    </span>
                                </span>
                            </div>
                        )}
                    </section>

                    <aside className="mt-10 rounded-xl bg-[#f1f3f5] px-5 py-4 text-xs leading-5 text-muted-foreground">
                        “Install integration” rechecks the Agent on this machine, then installs only the audited ACP
                        integration. It never installs, removes, upgrades, or signs in to the Agent CLI itself.
                    </aside>
                </div>
            </div>
        </>
    );
}

export function AgentSettingsPage({
    channelId,
    desktopSidebarCollapsed,
    onToggleDesktopSidebar,
}: {
    readonly channelId: string;
    readonly desktopSidebarCollapsed: boolean;
    readonly onToggleDesktopSidebar: () => void;
}) {
    const agents = useChatStore((state) => state.agents);
    const installableAgents = useChatStore((state) => state.installableAgents);
    const installations = useChatStore((state) => state.agentInstallations);
    const machineName = useChatStore((state) => state.machineName);
    const runtime = useChatStore((state) => state.runtime);
    const setSidebarOpen = useChatStore((state) => state.setSidebarOpen);
    const sidebarOpen = useChatStore((state) => state.sidebarOpen);
    return (
        <AgentSettingsView
            agents={agents}
            desktopSidebarCollapsed={desktopSidebarCollapsed}
            installableAgents={installableAgents}
            installations={installations}
            machineName={machineName}
            onCancelInstallation={(agentId) => void cancelLocalAgentInstallation(agentId)}
            onInstall={(agentId) => void installLocalAgent(agentId)}
            onOpenSidebar={() => setSidebarOpen(true)}
            onToggleDesktopSidebar={onToggleDesktopSidebar}
            runtimeCanSend={runtime.canSend}
            runtimeLabel={runtime.label}
            sidebarOpen={sidebarOpen}
            key={channelId}
        />
    );
}
