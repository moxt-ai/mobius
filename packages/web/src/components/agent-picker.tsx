import { Check, ChevronDown, LockKeyhole } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { AgentProductIcon } from "@/components/agent-product-icon";
import { cn } from "@/lib/utils";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

export function AgentPicker() {
    const agents = useChatStore((state) => state.agents);
    const conversation = useChatStore(selectActiveConversation);
    const selectAgent = useChatStore((state) => state.selectAgent);
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const pickerId = useId();
    const locked = conversation.contextLocked || conversation.isRunning;

    useEffect(() => {
        if (!open) {
            return;
        }
        const controller = new AbortController();
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (event.target instanceof Node && wrapperRef.current?.contains(event.target) !== true) {
                    setOpen(false);
                }
            },
            { signal: controller.signal },
        );
        document.addEventListener(
            "keydown",
            (event) => {
                if (event.key === "Escape") {
                    event.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus({ preventScroll: true });
                }
            },
            { signal: controller.signal },
        );
        return () => controller.abort();
    }, [open]);

    useEffect(() => {
        if (locked) {
            setOpen(false);
        }
    }, [locked]);

    return (
        <div className="relative shrink-0" ref={wrapperRef}>
            {locked ? (
                <span
                    aria-label={`${conversation.agentLabel}, locked for this conversation`}
                    className="hidden h-11 min-w-0 shrink-0 items-center gap-2 rounded-full border-[0.5px] border-black/[0.06] bg-black/[0.02] px-2.5 text-xs font-medium text-muted-foreground sm:inline-flex lg:h-9 lg:max-w-[180px]"
                    role="status"
                    title="Start a new chat to choose another Agent"
                >
                    <AgentProductIcon
                        agentId={conversation.agentId}
                        agentLabel={conversation.agentLabel}
                        className="size-[18px] rounded-[5px]"
                    />
                    <span className="hidden min-w-0 truncate lg:block">{conversation.agentLabel}</span>
                    <LockKeyhole aria-hidden="true" className="size-3.5 shrink-0 text-copy-tertiary" />
                </span>
            ) : (
                <button
                    aria-controls={pickerId}
                    aria-expanded={open}
                    aria-haspopup="dialog"
                    aria-label="Agent for this conversation"
                    className="inline-flex h-11 w-11 min-w-0 shrink-0 items-center justify-center gap-0 rounded-full border-0 bg-transparent px-0 text-xs font-medium text-muted-foreground shadow-none outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-black/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 lg:h-9 lg:w-auto lg:max-w-[180px] lg:justify-between lg:gap-2 lg:bg-black/[0.035] lg:px-2.5"
                    onClick={() => setOpen((current) => !current)}
                    ref={triggerRef}
                    title="Choose a local Agent"
                    type="button"
                >
                    <span className="flex min-w-0 items-center gap-0 lg:gap-2">
                        <AgentProductIcon
                            agentId={conversation.agentId}
                            agentLabel={conversation.agentLabel}
                            className="size-[18px] rounded-[5px]"
                        />
                        <span className="sr-only lg:not-sr-only lg:truncate">{conversation.agentLabel}</span>
                    </span>
                    <ChevronDown
                        aria-hidden="true"
                        className={cn(
                            "hidden size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none lg:block",
                            open && "rotate-180",
                        )}
                    />
                </button>
            )}

            {open && !locked && (
                <section
                    aria-label="Choose local Agent"
                    className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] left-3 z-50 max-h-72 overflow-y-auto rounded-xl border-[0.5px] border-black/10 bg-white p-1.5 shadow-[0_14px_42px_rgba(0,0,0,0.16)] lg:absolute lg:right-auto lg:bottom-[calc(100%+8px)] lg:left-0 lg:w-80"
                    id={pickerId}
                    role="dialog"
                >
                    {agents.map((agent) => (
                        <button
                            aria-current={agent.id === conversation.agentId ? "true" : undefined}
                            className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-xs outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-ring/70"
                            key={agent.id}
                            onClick={() => {
                                if (agent.id !== conversation.agentId) {
                                    selectAgent(agent.id);
                                }
                                setOpen(false);
                            }}
                            type="button"
                        >
                            <AgentProductIcon agentId={agent.id} agentLabel={agent.label} />
                            <span className="min-w-0 flex-1 truncate font-medium">{agent.label}</span>
                            {agent.id === conversation.agentId && (
                                <Check aria-hidden="true" className="size-3.5 shrink-0 text-success" />
                            )}
                        </button>
                    ))}
                </section>
            )}
        </div>
    );
}
