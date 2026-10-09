import { Cable, CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import {
    type AgentInstallationViewState,
    AgentIntegrationOption,
    FailedAgentInstallationState,
    IdleAgentInstallationState,
    type InstallableAgentOption,
    MissingAgentOption,
    SucceededAgentInstallationState,
} from "@/domain/channel";

interface AgentInstallationCardsViewProps {
    readonly agents: readonly InstallableAgentOption[];
    readonly installations: readonly AgentInstallationViewState[];
}

export function AgentInstallationCardsView({ agents, installations }: AgentInstallationCardsViewProps) {
    return (
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
            {agents.map((agent) => {
                const installation = installations.find((candidate) => candidate.agentId === agent.id);
                const succeeded = installation instanceof SucceededAgentInstallationState;
                const failed = installation instanceof FailedAgentInstallationState;
                const active = installation?.canCancel === true;
                const missing = agent instanceof MissingAgentOption;
                const statusLabel = active
                    ? "Checking"
                    : succeeded
                      ? "Ready"
                      : failed
                        ? "Needs attention"
                        : missing
                          ? "Not installed"
                          : "Agent detected";
                if (!missing && !(agent instanceof AgentIntegrationOption)) {
                    throw new Error("Unsupported local Agent integration option");
                }
                return (
                    <article
                        className="rounded-xl border-[0.5px] border-black/10 bg-white p-4 text-left shadow-[0_1px_3px_rgba(0,0,0,0.03)]"
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
                                        failed || (missing && !active)
                                            ? "mt-0.5 block text-[11px] leading-4 font-medium text-[#a85d00]"
                                            : "mt-0.5 block text-[11px] leading-4 font-medium text-[#218854]"
                                    }
                                >
                                    {statusLabel}
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
                            aria-live={active || failed ? "polite" : undefined}
                            className="mt-3 text-[11px] leading-4 text-muted-foreground"
                        >
                            {installation !== undefined && !(installation instanceof IdleAgentInstallationState)
                                ? installation.message
                                : missing
                                  ? `Install ${agent.label} on this machine, then choose Check again. Mobius will detect it and install its integration automatically.`
                                  : "Mobius detected this Agent and automatically installs and verifies its integration while the daemon is online."}
                        </p>
                    </article>
                );
            })}
        </div>
    );
}
