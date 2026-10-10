import { Agent, type Dispatcher, EnvHttpProxyAgent } from "undici";

export type RelayProxyPolicy = "direct" | "environment";

const configuredHttpProxy = process.env["http_proxy"] ?? process.env["HTTP_PROXY"] ?? "";
const configuredHttpsProxy = process.env["https_proxy"] ?? process.env["HTTPS_PROXY"] ?? configuredHttpProxy;

export const environmentProxyDispatcher = new EnvHttpProxyAgent();
export const directRelayDispatcher = new Agent();

export function relayDispatcher(policy: RelayProxyPolicy): Dispatcher {
    switch (policy) {
        case "direct":
            return directRelayDispatcher;
        case "environment":
            return environmentProxyDispatcher;
    }
}

function bypassesProxy(target: URL): boolean {
    const noProxy = process.env["no_proxy"] ?? process.env["NO_PROXY"] ?? "";
    if (noProxy === "*") {
        return true;
    }
    const hostname = target.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    const defaultPort = target.protocol === "wss:" || target.protocol === "https:" ? 443 : 80;
    const port = Number.parseInt(target.port, 10) || defaultPort;
    for (const rawEntry of noProxy.split(/[,\s]/u)) {
        if (rawEntry.length === 0) {
            continue;
        }
        const parsed = rawEntry.match(/^(.+):(\d+)$/u);
        const entryHostname = (parsed?.[1] ?? rawEntry).replace(/^\*?\./u, "").toLowerCase();
        const entryPort = parsed?.[2] === undefined ? 0 : Number.parseInt(parsed[2], 10);
        if (entryPort !== 0 && entryPort !== port) {
            continue;
        }
        if (hostname === entryHostname || hostname.endsWith(`.${entryHostname}`)) {
            return true;
        }
    }
    return false;
}

function sanitizedProxyOrigin(proxyUrl: string): string {
    try {
        return new URL(proxyUrl).origin;
    } catch {
        return "configured-invalid-url";
    }
}

export function describeRelayRoute(target: URL, policy: RelayProxyPolicy): Readonly<Record<string, string>> {
    if (policy === "direct") {
        return { proxyRoute: "direct" };
    }
    if (bypassesProxy(target)) {
        return { proxyRoute: "direct" };
    }
    const proxyUrl =
        target.protocol === "wss:" || target.protocol === "https:" ? configuredHttpsProxy : configuredHttpProxy;
    if (proxyUrl.length === 0) {
        return { proxyRoute: "direct" };
    }
    return {
        proxyOrigin: sanitizedProxyOrigin(proxyUrl),
        proxyRoute: "proxy",
    };
}
