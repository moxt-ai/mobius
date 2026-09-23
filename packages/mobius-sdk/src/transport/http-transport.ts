export interface MobiusHttpTransport {
    readonly fetch: (request: Request) => Promise<Response>;
}

export class HttpTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
}
