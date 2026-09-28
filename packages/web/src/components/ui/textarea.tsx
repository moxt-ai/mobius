import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
    return (
        <textarea
            className={cn(
                "flex min-h-16 w-full resize-none bg-transparent px-1 py-1 text-base leading-6 text-foreground outline-none placeholder:text-[15px] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 lg:text-[15px]",
                className,
            )}
            data-slot="textarea"
            {...props}
        />
    );
}
