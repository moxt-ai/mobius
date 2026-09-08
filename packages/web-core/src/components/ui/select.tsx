import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Select(props: ComponentProps<typeof SelectPrimitive.Root>) {
    return <SelectPrimitive.Root data-slot="select" {...props} />;
}

export function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
    return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

export function SelectGroup(props: ComponentProps<typeof SelectPrimitive.Group>) {
    return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
    return (
        <SelectPrimitive.Label
            className={cn(
                "px-2.5 pt-2 pb-1 text-[10px] leading-4 font-semibold tracking-[0.04em] text-muted-foreground",
                className,
            )}
            data-slot="select-label"
            {...props}
        />
    );
}

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Trigger>) {
    return (
        <SelectPrimitive.Trigger
            className={cn(
                "inline-flex h-9 min-w-[136px] items-center justify-between gap-2 rounded-lg border-[0.5px] border-black/10 bg-white px-2.5 text-xs font-medium text-copy-secondary outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/70 disabled:cursor-not-allowed disabled:opacity-50",
                className,
            )}
            data-slot="select-trigger"
            {...props}
        >
            {children}
            <SelectPrimitive.Icon asChild>
                <ChevronDown className="size-3.5 text-muted-foreground" />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
}

export function SelectContent({
    className,
    children,
    position = "popper",
    ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
    return (
        <SelectPrimitive.Portal>
            <SelectPrimitive.Content
                className={cn(
                    "relative z-50 max-h-72 min-w-[9rem] overflow-hidden rounded-[10px] border-[0.5px] border-black/10 bg-white text-foreground shadow-[0_10px_32px_rgba(0,0,0,0.12)]",
                    position === "popper" &&
                        "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
                    className,
                )}
                data-slot="select-content"
                position={position}
                {...props}
            >
                <SelectPrimitive.ScrollUpButton className="flex h-6 cursor-default items-center justify-center bg-white">
                    <ChevronUp className="size-3.5" />
                </SelectPrimitive.ScrollUpButton>
                <SelectPrimitive.Viewport
                    className={cn(
                        "p-1",
                        position === "popper" &&
                            "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
                    )}
                >
                    {children}
                </SelectPrimitive.Viewport>
                <SelectPrimitive.ScrollDownButton className="flex h-6 cursor-default items-center justify-center bg-white">
                    <ChevronDown className="size-3.5" />
                </SelectPrimitive.ScrollDownButton>
            </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
    );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
    return (
        <SelectPrimitive.Item
            className={cn(
                "relative flex min-h-11 w-full cursor-default select-none items-center rounded-[7px] py-2 pr-8 pl-2.5 text-xs outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-black/5 data-[state=checked]:font-medium data-[disabled]:opacity-50 md:min-h-9",
                className,
            )}
            data-slot="select-item"
            {...props}
        >
            <span className="absolute right-2 flex size-4 items-center justify-center">
                <SelectPrimitive.ItemIndicator>
                    <Check className="size-3.5 text-success" />
                </SelectPrimitive.ItemIndicator>
            </span>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </SelectPrimitive.Item>
    );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
    return (
        <SelectPrimitive.Separator
            className={cn("my-1 h-px bg-black/[0.07]", className)}
            data-slot="select-separator"
            {...props}
        />
    );
}
