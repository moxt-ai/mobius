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

function botDirectoryRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/bots`;
}

export function projectRuntimeRoutePath(projectId: string, runtimeId: string): string {
    return `/projects/${encodeURIComponent(projectId)}/runtimes/${encodeURIComponent(runtimeId)}`;
}

export abstract class WorkspaceRoutePaths {
    abstract readonly accessPath: string;
    abstract readonly botDirectoryPath: string;
    abstract readonly rootPath: string;
    abstract readonly runtimesPath: string;
    abstract readonly settingsPath: string;
    abstract readonly botConnectionsPath: (botId: string) => string;
    abstract readonly botConversationPath: (botId: string, conversationId: string) => string;
    abstract readonly botConversationsPath: (botId: string) => string;
    abstract readonly botPath: (botId: string) => string;
    abstract readonly isBotsPath: (path: string) => boolean;
    abstract readonly isSessionSettingsPath: (path: string) => boolean;
    abstract readonly sessionPath: (sessionId: string) => string;
    abstract readonly sessionSettingsPath: (sessionId: string) => string;
}

export class ChannelWorkspaceRoutePaths extends WorkspaceRoutePaths {
    readonly accessPath: string;
    readonly botDirectoryPath: string;
    readonly rootPath: string;
    readonly runtimesPath: string;
    readonly settingsPath: string;

    constructor(channelId: string) {
        super();
        this.accessPath = channelAccessRoutePath(channelId);
        this.botDirectoryPath = botDirectoryRoutePath(channelId);
        this.rootPath = channelRoutePath(channelId);
        this.runtimesPath = channelRuntimesRoutePath(channelId);
        this.settingsPath = channelSettingsRoutePath(channelId);
    }

    readonly botConnectionsPath = (botId: string): string => `${this.botPath(botId)}/connections`;

    readonly botConversationPath = (botId: string, conversationId: string): string =>
        `${this.botConversationsPath(botId)}/${encodeURIComponent(conversationId)}`;

    readonly botConversationsPath = (botId: string): string => `${this.botPath(botId)}/conversations`;

    readonly botPath = (botId: string): string => `${this.botDirectoryPath}/${encodeURIComponent(botId)}`;

    readonly isBotsPath = (path: string): boolean =>
        path === this.botDirectoryPath || path.startsWith(`${this.botDirectoryPath}/`);

    readonly isSessionSettingsPath = (path: string): boolean =>
        path.startsWith(`${this.rootPath}/sessions/`) && path.endsWith("/settings");

    readonly sessionPath = (sessionId: string): string => `${this.rootPath}/sessions/${encodeURIComponent(sessionId)}`;

    readonly sessionSettingsPath = (sessionId: string): string => `${this.sessionPath(sessionId)}/settings`;
}

export class ProjectRuntimeWorkspaceRoutePaths extends WorkspaceRoutePaths {
    readonly accessPath: string;
    readonly botDirectoryPath: string;
    readonly rootPath: string;
    readonly runtimesPath: string;
    readonly settingsPath: string;

    constructor(projectId: string, runtimeId: string, ownerChannelId: string) {
        super();
        this.accessPath = channelAccessRoutePath(ownerChannelId);
        this.rootPath = projectRuntimeRoutePath(projectId, runtimeId);
        this.botDirectoryPath = `${this.rootPath}/bots`;
        this.runtimesPath = `${this.rootPath}/machines`;
        this.settingsPath = `${this.rootPath}/settings`;
    }

    readonly botConnectionsPath = (botId: string): string => `${this.botPath(botId)}/connections`;

    readonly botConversationPath = (botId: string, conversationId: string): string =>
        `${this.botConversationsPath(botId)}/${encodeURIComponent(conversationId)}`;

    readonly botConversationsPath = (botId: string): string => `${this.botPath(botId)}/conversations`;

    readonly botPath = (botId: string): string => `${this.botDirectoryPath}/${encodeURIComponent(botId)}`;

    readonly isBotsPath = (path: string): boolean =>
        path === this.botDirectoryPath || path.startsWith(`${this.botDirectoryPath}/`);

    readonly isSessionSettingsPath = (path: string): boolean =>
        path.startsWith(`${this.rootPath}/sessions/`) && path.endsWith("/settings");

    readonly sessionPath = (sessionId: string): string => `${this.rootPath}/sessions/${encodeURIComponent(sessionId)}`;

    readonly sessionSettingsPath = (sessionId: string): string => `${this.sessionPath(sessionId)}/settings`;
}
