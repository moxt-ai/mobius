import { isIdentifier } from "@/domain/channel";

const PROJECT_RUNTIME_ACCESS_STATE_KEY = "mobiusAccessChannelId";

/**
 * A Project Runtime route is addressable from any channel in the Project, so the channel that opened it
 * travels in the navigation state. It decides which saved credential the page resolves and where the
 * "Access from other devices" and "Local machines" links point. Navigation state does not survive a
 * reload or a cold deep link, so an absent or malformed value falls back to the channel recorded by the
 * resolved Project owner credential, and device access stays hidden when neither names one.
 */
export function projectRuntimeRouteState(channelId: string): { readonly mobiusAccessChannelId: string } {
    return { [PROJECT_RUNTIME_ACCESS_STATE_KEY]: channelId };
}

export function decodeProjectRuntimeRouteState(state: unknown): string {
    if (typeof state !== "object" || state === null) {
        return "";
    }
    const value = Reflect.get(state, PROJECT_RUNTIME_ACCESS_STATE_KEY);
    return typeof value === "string" && isIdentifier(value) ? value : "";
}

function channelRoutePath(channelId: string): string {
    return `/channels/${encodeURIComponent(channelId)}`;
}

function channelAccessRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/access`;
}

function channelRuntimesRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/runtimes`;
}

function channelSettingsRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/settings`;
}

export function projectRuntimeRoutePath(projectId: string, runtimeId: string): string {
    return `/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(runtimeId)}`;
}

/**
 * Device access is scoped to one channel. A workspace that cannot name that channel has no addressable
 * access page, so the link is representable as unavailable instead of a route that matches no channel.
 */
export type ChannelAccessSettings =
    | { readonly kind: "available"; readonly path: string }
    | { readonly kind: "unavailable" };

export abstract class WorkspaceRoutePaths {
    abstract readonly access: ChannelAccessSettings;
    abstract readonly rootPath: string;
    abstract readonly runtimesPath: string;
    abstract readonly settingsPath: string;
    abstract readonly isSessionSettingsPath: (path: string) => boolean;
    abstract readonly sessionPath: (sessionId: string) => string;
    abstract readonly sessionSettingsPath: (sessionId: string) => string;
}

export class ChannelWorkspaceRoutePaths extends WorkspaceRoutePaths {
    readonly access: ChannelAccessSettings;
    readonly rootPath: string;
    readonly runtimesPath: string;
    readonly settingsPath: string;

    constructor(channelId: string) {
        super();
        this.access = { kind: "available", path: channelAccessRoutePath(channelId) };
        this.rootPath = channelRoutePath(channelId);
        this.runtimesPath = channelRuntimesRoutePath(channelId);
        this.settingsPath = channelSettingsRoutePath(channelId);
    }

    readonly isSessionSettingsPath = (path: string): boolean =>
        path.startsWith(`${this.rootPath}/sessions/`) && path.endsWith("/settings");

    readonly sessionPath = (sessionId: string): string => `${this.rootPath}/sessions/${encodeURIComponent(sessionId)}`;

    readonly sessionSettingsPath = (sessionId: string): string => `${this.sessionPath(sessionId)}/settings`;
}

export class ProjectRuntimeWorkspaceRoutePaths extends WorkspaceRoutePaths {
    readonly access: ChannelAccessSettings;
    readonly rootPath: string;
    readonly runtimesPath: string;
    readonly settingsPath: string;

    constructor(projectId: string, runtimeId: string, accessChannelId: string) {
        super();
        // Standalone authenticates the browser at the Project boundary. Its token cannot mint or
        // administer the legacy per-channel access grants, so do not advertise a route that will
        // always reject that credential.
        this.access =
            projectId !== "standalone" && isIdentifier(accessChannelId)
                ? { kind: "available", path: channelAccessRoutePath(accessChannelId) }
                : { kind: "unavailable" };
        this.rootPath = projectRuntimeRoutePath(projectId, runtimeId);
        this.runtimesPath = `${this.rootPath}/machines`;
        this.settingsPath = `${this.rootPath}/settings`;
    }

    readonly isSessionSettingsPath = (path: string): boolean =>
        path.startsWith(`${this.rootPath}/sessions/`) && path.endsWith("/settings");

    readonly sessionPath = (sessionId: string): string => `${this.rootPath}/sessions/${encodeURIComponent(sessionId)}`;

    readonly sessionSettingsPath = (sessionId: string): string => `${this.sessionPath(sessionId)}/settings`;
}
