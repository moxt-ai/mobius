import { MobiusCancellationError, MobiusProtocolError } from "./errors.ts";
import { MobiusPublicRequestExecutor } from "./public-request.ts";
import type { MobiusCredentialProvider, MobiusResponseMetadata } from "./service-client.ts";
import type { MobiusHttpTransport } from "./transport/http-transport.ts";

export interface MobiusStandaloneCredentialProviderOptions {
    readonly endpoint: string;
    readonly observeResponse?: (metadata: MobiusResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

export class MobiusStandaloneProjectCredential {
    readonly projectId: string;
    readonly token: string;

    constructor(projectId: string, token: string) {
        this.projectId = projectId;
        this.token = token;
    }
}

function decodeStandaloneProjectCredential(value: unknown): MobiusStandaloneProjectCredential {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MobiusProtocolError("The service returned an invalid Standalone Project credential");
    }
    const projectId = Reflect.get(value, "projectId");
    const token = Reflect.get(value, "token");
    if (
        typeof projectId !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(projectId) ||
        typeof token !== "string" ||
        !/^[a-zA-Z0-9_-]{32,256}$/u.test(token) ||
        Object.keys(value).length !== 2
    ) {
        throw new MobiusProtocolError("The service returned an invalid Standalone Project credential");
    }
    return new MobiusStandaloneProjectCredential(projectId, token);
}

/**
 * Creates one Standalone Project for a pairing workflow and holds its owner credential.
 * The deployment owner credential never enters the browser.
 */
export class MobiusStandaloneCredentialProvider implements MobiusCredentialProvider {
    readonly #requests: MobiusPublicRequestExecutor;
    #current: MobiusStandaloneProjectCredential | null = null;

    constructor(options: MobiusStandaloneCredentialProviderOptions) {
        this.#requests = new MobiusPublicRequestExecutor(options);
    }

    readonly projectCredential = async (signal: AbortSignal): Promise<MobiusStandaloneProjectCredential> => {
        if (signal.aborted) {
            throw new MobiusCancellationError({ cause: signal.reason });
        }
        if (this.#current !== null) {
            return this.#current;
        }
        const credential = decodeStandaloneProjectCredential(
            await this.#requests.post("v1/standalone/projects", {}, signal),
        );
        this.#current = credential;
        return credential;
    };

    readonly credential = async (signal: AbortSignal): Promise<string> => (await this.projectCredential(signal)).token;
}
