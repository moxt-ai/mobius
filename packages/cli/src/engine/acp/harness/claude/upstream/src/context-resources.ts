import { extname } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";

type Resource = Extract<ContentBlock, { readonly type: "resource" }>;
interface TextBlock {
    readonly type: string;
    readonly text?: unknown;
}

export function formatUriAsLink(uri: string): string {
    if (uri.startsWith("file://")) {
        const path = uri.slice(7);
        return `[@${path.split("/").pop() || path}](${uri})`;
    }
    if (uri.startsWith("zed://")) {
        return `[@${uri.split("/").pop() || uri}](${uri})`;
    }
    return uri;
}

export const formatContextBlock = (uri: string, text: string): string =>
    `\n<context ref="${uri}">\n${text}\n</context>`;

function parseContextBlock(block: TextBlock): { readonly uri: string; readonly text: string } | null {
    if (block.type !== "text" || typeof block.text !== "string") {
        return null;
    }
    const match = /^\n<context ref="([^"\r\n]+)">\n([\s\S]*)\n<\/context>$/u.exec(block.text);
    const uri = match?.[1];
    const text = match?.[2];
    if (uri === undefined || text === undefined || formatContextBlock(uri, text) !== block.text) {
        return null;
    }
    return { uri, text };
}

function contextMimeType(uri: string): string {
    let pathname = uri;
    try {
        pathname = new URL(uri).pathname;
    } catch {
        // Resource identifiers need not be absolute URLs.
    }
    switch (extname(pathname).toLowerCase()) {
        case ".html":
        case ".htm":
            return "text/html";
        case ".js":
        case ".mjs":
        case ".cjs":
            return "text/javascript";
        case ".css":
            return "text/css";
        case ".json":
            return "application/json";
        case ".md":
        case ".markdown":
            return "text/markdown";
        case ".xml":
            return "application/xml";
        case ".svg":
            return "image/svg+xml";
        case ".csv":
            return "text/csv";
        default:
            return "text/plain";
    }
}

/** Decode only the complete trailing context/link representation written by promptToClaude. */
export function replayContextResources(content: readonly TextBlock[]): {
    readonly contextStart: number;
    readonly resources: ReadonlyMap<number, Resource>;
} | null {
    const contexts: { readonly uri: string; readonly text: string }[] = [];
    let contextStart = content.length;
    for (let index = content.length - 1; index >= 0; index -= 1) {
        const block = content[index];
        const parsed = block === undefined ? null : parseContextBlock(block);
        if (parsed === null) {
            break;
        }
        contexts.push(parsed);
        contextStart = index;
    }
    if (contexts.length === 0) {
        return null;
    }
    contexts.reverse();
    const links = new Set(contexts.map(({ uri }) => formatUriAsLink(uri)));
    const resources = new Map<number, Resource>();
    let nextContext = 0;
    for (let index = 0; index < contextStart; index += 1) {
        const block = content[index];
        if (block?.type !== "text" || typeof block.text !== "string") {
            continue;
        }
        // A non-trailing or malformed context makes the representation ambiguous.
        if (block.text.startsWith('\n<context ref="')) {
            return null;
        }
        if (!links.has(block.text)) {
            continue;
        }
        const context = contexts[nextContext];
        if (context === undefined || block.text !== formatUriAsLink(context.uri)) {
            return null;
        }
        resources.set(index, {
            type: "resource",
            resource: { ...context, mimeType: contextMimeType(context.uri) },
        });
        nextContext += 1;
    }
    return nextContext === contexts.length ? { contextStart, resources } : null;
}
