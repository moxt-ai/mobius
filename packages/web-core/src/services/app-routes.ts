export function channelRoutePath(channelId: string): string {
  return `/channels/${encodeURIComponent(channelId)}`;
}

export function channelAccessRoutePath(channelId: string): string {
  return `${channelRoutePath(channelId)}/access`;
}

export function channelSettingsRoutePath(channelId: string): string {
  return `${channelRoutePath(channelId)}/settings`;
}

export function sessionRoutePath(channelId: string, sessionId: string): string {
  return `${channelRoutePath(channelId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function sessionSettingsRoutePath(
  channelId: string,
  sessionId: string,
): string {
  return `${sessionRoutePath(channelId, sessionId)}/settings`;
}
