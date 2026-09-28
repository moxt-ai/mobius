import { MobiusCancellationError, MobiusProtocolError } from "./errors.ts";
import { MobiusPublicRequestExecutor } from "./public-request.ts";
import { decodeMobiusBrowserCredential, type MobiusBrowserCredential } from "./resources.ts";
import type { MobiusCredentialProvider, MobiusResponseMetadata } from "./service-client.ts";
import type { MobiusHttpTransport } from "./transport/http-transport.ts";

const CREDENTIAL_EXPIRY_MARGIN_MILLISECONDS = 30_000;

export interface MobiusStandaloneCredentialProviderOptions {
    readonly endpoint: string;
    readonly observeResponse?: (metadata: MobiusResponseMetadata) => void;
    readonly operationTimeoutMilliseconds?: number;
    readonly transport?: MobiusHttpTransport;
}

/**
 * Exchanges the Standalone Relay's public bootstrap endpoint for a short-lived,
 * scoped browser credential. The deployment owner credential never enters the browser.
 */
export class MobiusStandaloneCredentialProvider implements MobiusCredentialProvider {
    readonly #requests: MobiusPublicRequestExecutor;
    #current: MobiusBrowserCredential | null = null;

    constructor(options: MobiusStandaloneCredentialProviderOptions) {
        this.#requests = new MobiusPublicRequestExecutor(options);
    }

    readonly browserCredential = async (signal: AbortSignal): Promise<MobiusBrowserCredential> => {
        if (signal.aborted) {
            throw new MobiusCancellationError({ cause: signal.reason });
        }
        if (
            this.#current !== null &&
            Date.parse(this.#current.expiresAt) - Date.now() > CREDENTIAL_EXPIRY_MARGIN_MILLISECONDS
        ) {
            return this.#current;
        }
        const credential = decodeMobiusBrowserCredential(
            await this.#requests.post("v1/standalone/browser-credentials", {}, signal),
        );
        if (credential.projectId !== "standalone") {
            throw new MobiusProtocolError("The service returned a credential for another Project");
        }
        this.#current = credential;
        return credential;
    };

    readonly credential = async (signal: AbortSignal): Promise<string> => (await this.browserCredential(signal)).token;
}
