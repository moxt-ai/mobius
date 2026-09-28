import { cn } from "@/lib/utils";

export interface AgentAvatarProps {
    readonly className?: string;
    readonly compact?: boolean;
    readonly floating?: boolean;
}

export function AgentAvatar({ className, compact = false, floating = false }: AgentAvatarProps) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "relative shrink-0 overflow-hidden bg-[#e9f8f0] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]",
                compact ? "size-8 rounded-[10px]" : "size-[66px] rounded-full",
                floating && "agent-float",
                className,
            )}
        >
            <span className="absolute top-[24%] left-[17%] h-[42%] w-[52%] -rotate-12 rounded-[48%_52%_44%_56%] bg-[#2fb872]" />
            <span className="absolute right-[10%] bottom-[13%] size-[38%] rotate-[18deg] rounded-[52%_44%_56%_48%] bg-[#f5b95f]" />
            <span className="absolute top-[12%] right-[20%] size-[23%] rounded-full bg-[#7d75db]" />
        </div>
    );
}
