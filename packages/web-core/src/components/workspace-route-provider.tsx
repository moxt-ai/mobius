import { createContext, type ReactNode, useContext } from "react";

import { ChannelWorkspaceRoutePaths, type WorkspaceRoutePaths } from "@/services/app-routes";

const WorkspaceRouteContext = createContext<WorkspaceRoutePaths>(new ChannelWorkspaceRoutePaths("unavailable"));

export function WorkspaceRouteProvider({
    children,
    routes,
}: {
    readonly children: ReactNode;
    readonly routes: WorkspaceRoutePaths;
}) {
    return <WorkspaceRouteContext.Provider value={routes}>{children}</WorkspaceRouteContext.Provider>;
}

export function useWorkspaceRoutes(): WorkspaceRoutePaths {
    return useContext(WorkspaceRouteContext);
}
