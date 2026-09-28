import { LoaderCircle, TriangleAlert, Wifi, WifiOff } from "lucide-react";

import type { RuntimeConnectionAppearance, RuntimeConnectionState } from "@/domain/chat";
import { cn } from "@/lib/utils";

interface SidebarRuntimeStatusProps {
    readonly runtime: RuntimeConnectionState;
}

const APPEARANCE_CLASS_NAMES: Readonly<Record<RuntimeConnectionAppearance, string>> = {
    connecting: "bg-warning-subtle text-warning",
    offline: "bg-destructive/8 text-destructive",
    online: "bg-success-subtle text-success",
    unavailable: "bg-destructive/8 text-destructive",
};

function RuntimeStatusIcon({ appearance }: { readonly appearance: RuntimeConnectionAppearance }) {
    const iconClassName = "size-4";
    switch (appearance) {
        case "connecting":
            return (
                <LoaderCircle
                    aria-hidden="true"
                    className={cn(iconClassName, "animate-spin motion-reduce:animate-none")}
                    data-runtime-status-icon=""
                />
            );
        case "offline":
            return <WifiOff aria-hidden="true" className={iconClassName} data-runtime-status-icon="" />;
        case "online":
            return <Wifi aria-hidden="true" className={iconClassName} data-runtime-status-icon="" />;
        case "unavailable":
            return <TriangleAlert aria-hidden="true" className={iconClassName} data-runtime-status-icon="" />;
    }
}

export function SidebarRuntimeStatus({ runtime }: SidebarRuntimeStatusProps) {
    return (
        <span
            className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-full",
                APPEARANCE_CLASS_NAMES[runtime.appearance],
            )}
            data-runtime-status={runtime.appearance}
            role="status"
            title={runtime.label}
        >
            <RuntimeStatusIcon appearance={runtime.appearance} />
            <span className="sr-only">{runtime.label}</span>
        </span>
    );
}
