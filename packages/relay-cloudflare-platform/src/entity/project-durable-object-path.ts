const projectPathPrefix = "/mobius/internal/projects/";

export interface ProjectDurableObjectPath {
    readonly projectId: string;
    readonly requestPathname: string;
}

export function encodeProjectDurableObjectPath(projectId: string, requestPathname: string): string {
    return `${projectPathPrefix}${encodeURIComponent(projectId)}${requestPathname}`;
}

export function decodeProjectDurableObjectPath(pathname: string): ProjectDurableObjectPath | null {
    if (!pathname.startsWith(projectPathPrefix)) {
        return null;
    }
    const projectPath = pathname.slice(projectPathPrefix.length);
    const separator = projectPath.indexOf("/");
    if (separator < 0) {
        return null;
    }
    try {
        return {
            projectId: decodeURIComponent(projectPath.slice(0, separator)),
            requestPathname: projectPath.slice(separator),
        };
    } catch {
        return null;
    }
}
