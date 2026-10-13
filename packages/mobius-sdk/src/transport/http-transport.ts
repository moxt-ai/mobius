export interface MobiusHttpTransport {
    readonly fetch: (request: Request) => Promise<Response>;
}

export interface MobiusTransportSessionEvent {
    readonly data: string;
    readonly eventId: string;
    readonly seqId: number;
}

export interface MobiusLiveEventTransport {
    readonly openLiveSessionEvents: (request: Request) => Promise<ReadableStream<MobiusTransportSessionEvent>>;
}

export function isMobiusLiveEventTransport(
    transport: MobiusHttpTransport,
): transport is MobiusHttpTransport & MobiusLiveEventTransport {
    return "openLiveSessionEvents" in transport && typeof transport.openLiveSessionEvents === "function";
}

export class HttpTransport implements MobiusHttpTransport {
    readonly fetch = async (request: Request): Promise<Response> => await globalThis.fetch(request);
}
