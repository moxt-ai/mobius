import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium outline-none transition-colors duration-150 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        defaultVariants: {
            size: "default",
            variant: "default",
        },
        variants: {
            size: {
                default: "h-9 px-4 py-2",
                icon: "size-9",
                lg: "h-10 px-6",
                sm: "h-8 gap-1.5 px-3 text-xs",
            },
            variant: {
                default: "bg-foreground text-background shadow-xs hover:bg-foreground/85",
                ghost: "hover:bg-accent hover:text-accent-foreground",
                outline: "border border-border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
                secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
            },
        },
    },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {}

export function Button({ className, size, type = "button", variant, ...props }: ButtonProps) {
    return (
        <button
            className={cn(buttonVariants({ className, size, variant }))}
            data-slot="button"
            type={type}
            {...props}
        />
    );
}
