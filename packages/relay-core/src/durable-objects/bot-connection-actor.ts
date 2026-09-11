import type { DurableObjectContext } from "../di/create-durable-object-dependencies.ts";

export class BotConnectionActor {
    readonly #dependencies: DurableObjectContext;

    constructor(dependencies: DurableObjectContext) {
        this.#dependencies = dependencies;
    }

    async fetch(request: Request): Promise<Response> {
        return await this.#dependencies.applications.delivery.fetch(request);
    }

    async alarm(): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Delivery recovery timed out", "TimeoutError")),
            15_000,
        );
        try {
            await this.#dependencies.services.deliveries.recover(Date.now(), controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }
}
