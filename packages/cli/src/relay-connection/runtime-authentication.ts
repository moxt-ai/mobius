function runtimeCredential(relayUrl: URL): string {
    return relayUrl.searchParams.get("token") ?? "";
}

export function runtimeAuthorization(relayUrl: URL): Readonly<Record<string, string>> {
    const credential = runtimeCredential(relayUrl);
    return credential.length === 0 ? {} : { authorization: `Bearer ${credential}` };
}

export function relayHttpEndpoint(relayUrl: URL): URL {
    const endpoint = new URL(relayUrl);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    endpoint.search = "";
    return endpoint;
}
