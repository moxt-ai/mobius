import type { DurableObjectContext } from "../di/create-durable-object-dependencies.ts";

export class SessionRelay {
    readonly #dependencies: DurableObjectContext;

    constructor(dependencies: DurableObjectContext) {
        this.#dependencies = dependencies;
    }

    async fetch(request: Request): Promise<Response> {
        return await this.#dependencies.applications.session.fetch(request);
    }

    async alarm(): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Session recovery timed out", "TimeoutError")),
            15_000,
        );
        try {
            await this.#dependencies.services.sessionRecovery.recover(controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }
}
