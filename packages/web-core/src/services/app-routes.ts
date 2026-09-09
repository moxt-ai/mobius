export function channelRoutePath(channelId: string): string {
    return `/channels/${encodeURIComponent(channelId)}`;
}

export function channelAccessRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/access`;
}

export function channelRuntimesRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/runtimes`;
}

export function channelSettingsRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/settings`;
}

export function botDirectoryRoutePath(channelId: string): string {
    return `${channelRoutePath(channelId)}/bots`;
}

export function botRoutePath(channelId: string, botId: string): string {
    return `${botDirectoryRoutePath(channelId)}/${encodeURIComponent(botId)}`;
}

export function botConversationsRoutePath(channelId: string, botId: string): string {
    return `${botRoutePath(channelId, botId)}/conversations`;
}

export function botConversationRoutePath(channelId: string, botId: string, conversationId: string): string {
    return `${botConversationsRoutePath(channelId, botId)}/${encodeURIComponent(conversationId)}`;
}

export function botConnectionsRoutePath(channelId: string, botId: string): string {
    return `${botRoutePath(channelId, botId)}/connections`;
}

export function sessionRoutePath(channelId: string, sessionId: string): string {
    return `${channelRoutePath(channelId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function sessionSettingsRoutePath(channelId: string, sessionId: string): string {
    return `${sessionRoutePath(channelId, sessionId)}/settings`;
}
