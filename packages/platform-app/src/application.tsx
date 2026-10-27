import { useState } from "react";
import { createPlatformStore } from "./view-models/platform-app-view-model.ts";
import { type PlatformAppProps, PlatformAppView } from "./views/platform-app-view.tsx";

/** Composes the authenticated application with its state, after the identity provider selects an organization. */
export function PlatformApp(props: PlatformAppProps) {
    const [store] = useState(createPlatformStore);
    return <PlatformAppView {...props} store={store} />;
}
