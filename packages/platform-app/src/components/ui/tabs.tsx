import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";

export const Tabs = TabsPrimitive.Root;

export function TabsList(props: ComponentProps<typeof TabsPrimitive.List>) {
    return (
        <TabsPrimitive.List {...props} className={`flex gap-6 border-b border-[#e8ece9] ${props.className ?? ""}`} />
    );
}

export function TabsTrigger(props: ComponentProps<typeof TabsPrimitive.Trigger>) {
    return (
        <TabsPrimitive.Trigger
            {...props}
            className={`border-x-0 border-t-0 border-b-2 border-transparent bg-transparent px-0 pb-3 font-bold text-[#69766f] hover:text-[#168247] data-[state=active]:border-[#168247] data-[state=active]:text-[#168247] ${props.className ?? ""}`}
        />
    );
}

export function TabsContent(props: ComponentProps<typeof TabsPrimitive.Content>) {
    return <TabsPrimitive.Content {...props} className={`outline-none ${props.className ?? ""}`} />;
}
