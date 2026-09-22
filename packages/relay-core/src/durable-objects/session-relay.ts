import type { DurableObjectContext } from "../di/create-durable-object-dependencies.ts";
import { ProjectScope } from "../entity/do/session.ts";
import type { SessionEventReceiver } from "../infra/session-event-receiver.ts";

const SESSION_RECOVERY_TIMEOUT_MILLISECONDS = 60_000;

export class SessionRelay {
    readonly #dependencies: DurableObjectContext;

    constructor(dependencies: DurableObjectContext) {
        this.#dependencies = dependencies;
        dependencies.services.sessionRetention.repairLegacyNonRetainedTurns();
    }

    async fetch(request: Request): Promise<Response> {
        return await this.#dependencies.applications.session.fetch(request);
    }

    readonly scrubNonRetainedContent = (): void => {
        this.#dependencies.services.sessionRetention.scrubNonRetainedContent();
    };

    readonly subscribeToLiveSessionEvents = async (
        projectId: string,
        sessionId: string,
        receive: SessionEventReceiver,
    ): Promise<string> =>
        await this.#dependencies.services.sessionEventStreams.subscribeToLiveEvents(
            new ProjectScope(projectId),
            sessionId,
            receive,
            AbortSignal.timeout(20_000),
        );

    readonly unsubscribeFromLiveSessionEvents = (subscriptionId: string): void =>
        this.#dependencies.services.sessionEventStreams.unsubscribeFromLiveEvents(subscriptionId);

    async alarm(): Promise<void> {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(new DOMException("Session recovery timed out", "TimeoutError")),
            SESSION_RECOVERY_TIMEOUT_MILLISECONDS,
        );
        try {
            await this.#dependencies.services.sessionRecovery.recover(controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }
}
