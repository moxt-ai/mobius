import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type { ComponentProps } from "react";

export function Checkbox(props: ComponentProps<typeof CheckboxPrimitive.Root>) {
    return (
        <CheckboxPrimitive.Root
            {...props}
            className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded border border-[#9eaaa3] bg-white text-white disabled:opacity-50 data-[state=checked]:border-[#168247] data-[state=checked]:bg-[#168247] ${props.className ?? ""}`}
        >
            <CheckboxPrimitive.Indicator>
                <Check size={12} strokeWidth={3} />
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}
