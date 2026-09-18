import { render } from "@testing-library/react";
import { createElement } from "react";
import { PlatformApp, type PlatformAppProps } from "../../platform-app/src/views/platform-app-view.tsx";

export function createPlatformTestApplication(props: PlatformAppProps) {
    const application = render(createElement(PlatformApp, props));
    return {
        container: application.container,
        rerender: (next: PlatformAppProps, key: string): void =>
            application.rerender(createElement(PlatformApp, { ...next, key })),
        destroy: async (): Promise<void> => {
            application.unmount();
        },
    } as const;
}
