import {
    type ConversationAccessAuthorizer,
    type ConversationAccessContext,
    ConversationPermission,
} from "@moxt-ai/mobius-relay-core";

const AUTHORIZATION_REFRESH_MILLISECONDS = 5_000;

export class ConversationStreamRegistry {
    readonly #controllers = new Map<string, Set<AbortController>>();

    readonly open = (
        access: ConversationAccessContext,
        credential: string,
        authorizer: ConversationAccessAuthorizer,
        requestSignal: AbortSignal,
    ): ConversationStreamLease => {
        const controller = new AbortController();
        const controllers = this.#controllers.get(access.credentialId) ?? new Set<AbortController>();
        controllers.add(controller);
        this.#controllers.set(access.credentialId, controllers);
        return new ConversationStreamLease(access, credential, authorizer, requestSignal, controller, () =>
            this.remove(access.credentialId, controller),
        );
    };

    readonly revoke = (credentialId: string): void => {
        const controllers = this.#controllers.get(credentialId);
        if (controllers === undefined) {
            return;
        }
        for (const controller of controllers) {
            controller.abort(new Error("The Conversation credential was revoked"));
        }
        this.#controllers.delete(credentialId);
    };

    private readonly remove = (credentialId: string, controller: AbortController): void => {
        const controllers = this.#controllers.get(credentialId);
        if (controllers === undefined) {
            return;
        }
        controllers.delete(controller);
        if (controllers.size === 0) {
            this.#controllers.delete(credentialId);
        }
    };
}

export class ConversationStreamLease {
    readonly #authorizer: ConversationAccessAuthorizer;
    readonly #controller: AbortController;
    readonly #credential: string;
    readonly #expiresAtEpochMilliseconds: number;
    readonly #releaseRegistration: () => void;
    readonly #requestSignal: AbortSignal;
    readonly #expirationTimeoutId: ReturnType<typeof globalThis.setTimeout>;
    readonly #refreshIntervalId: ReturnType<typeof globalThis.setInterval>;
    #refreshing = false;
    #released = false;

    constructor(
        access: ConversationAccessContext,
        credential: string,
        authorizer: ConversationAccessAuthorizer,
        requestSignal: AbortSignal,
        controller: AbortController,
        releaseRegistration: () => void,
    ) {
        this.#authorizer = authorizer;
        this.#controller = controller;
        this.#credential = credential;
        this.#expiresAtEpochMilliseconds = access.lifetime.expiresAtEpochMilliseconds;
        this.#releaseRegistration = releaseRegistration;
        this.#requestSignal = requestSignal;
        if (requestSignal.aborted) {
            this.#controller.abort(requestSignal.reason);
        } else {
            requestSignal.addEventListener("abort", this.abortFromRequest, { once: true });
        }
        const expiresInMilliseconds = Math.max(0, this.#expiresAtEpochMilliseconds - Date.now());
        this.#expirationTimeoutId = globalThis.setTimeout(this.abortFromExpiration, expiresInMilliseconds);
        this.#refreshIntervalId = globalThis.setInterval(this.refreshAuthorization, AUTHORIZATION_REFRESH_MILLISECONDS);
        this.#controller.signal.addEventListener("abort", this.release, { once: true });
        if (this.#controller.signal.aborted) {
            this.release();
        }
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    readonly fail = (): void => this.release();

    readonly wrap = (response: Response): Response => {
        if (response.body === null) {
            this.release();
            throw new Error("The Conversation event stream has no body");
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
            cancel: async (reason) => {
                this.release();
                await reader.cancel(reason);
            },
            pull: async (controller) => {
                try {
                    const result = await reader.read();
                    if (result.done) {
                        this.release();
                        controller.close();
                        return;
                    }
                    controller.enqueue(result.value);
                } catch (cause) {
                    this.release();
                    controller.error(cause);
                }
            },
        });
        return new Response(body, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
        });
    };

    private readonly abortFromExpiration = (): void => {
        this.#controller.abort(new Error("The Conversation credential expired"));
    };

    private readonly abortFromRequest = (): void => {
        this.#controller.abort(this.#requestSignal.reason);
    };

    private readonly refreshAuthorization = (): void => {
        if (this.#released || this.#refreshing) {
            return;
        }
        this.#refreshing = true;
        const refresh = this.#authorizer
            .authorize(this.#credential, ConversationPermission.EventRead, this.#controller.signal)
            .then((access) => {
                if (access.lifetime.expiresAtEpochMilliseconds !== this.#expiresAtEpochMilliseconds) {
                    this.#controller.abort(new Error("The Conversation credential lifetime changed"));
                }
            })
            .catch((cause) => {
                this.#controller.abort(cause);
            })
            .finally(() => {
                this.#refreshing = false;
            });
        void refresh;
    };

    private readonly release = (): void => {
        if (this.#released) {
            return;
        }
        this.#released = true;
        globalThis.clearTimeout(this.#expirationTimeoutId);
        globalThis.clearInterval(this.#refreshIntervalId);
        this.#controller.signal.removeEventListener("abort", this.release);
        this.#requestSignal.removeEventListener("abort", this.abortFromRequest);
        this.#releaseRegistration();
    };
}
