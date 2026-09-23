import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import type { HttpError, SessionEventReceiver } from "@moxt-ai/mobius-relay-core";
import type { StandaloneRelayBindings } from "./worker.ts";

type LiveEventTarget =
    | { readonly kind: "durable"; readonly projectId: string; readonly runtimeId: string }
    | {
          readonly expiresAtEpochMilliseconds: number;
          readonly kind: "expiring";
          readonly projectId: string;
          readonly runtimeId: string;
      };

export interface LiveSessionEventReceiverFactory {
    readonly create: (receiver: SessionEventReceiver) => SessionEventReceiver;
}

export const directLiveSessionEventReceiverFactory: LiveSessionEventReceiverFactory = {
    create: (receiver) => receiver,
};

class LiveEventSubscriptionError extends Error implements HttpError {
    readonly #code: string;
    readonly #status: number;

    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = "LiveEventSubscriptionError";
        this.#code = code;
        this.#status = status;
    }

    readonly toHttpJson: HttpError["toHttpJson"] = () => ({
        body: { error: { code: this.#code, message: this.message } },
        status: this.#status,
    });
}

async function decodeLiveEventTarget(response: Response): Promise<LiveEventTarget> {
    const value: unknown = await response.json();
    if (!response.ok) {
        const error =
            typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, "error") : null;
        throw new LiveEventSubscriptionError(
            typeof error === "object" && error !== null && typeof Reflect.get(error, "code") === "string"
                ? Reflect.get(error, "code")
                : "subscription_authorization_failed",
            typeof error === "object" && error !== null && typeof Reflect.get(error, "message") === "string"
                ? Reflect.get(error, "message")
                : "The live Session event subscription could not be authorized",
            response.status,
        );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 502);
    }
    const kind = Reflect.get(value, "kind");
    const projectId = Reflect.get(value, "projectId");
    const runtimeId = Reflect.get(value, "runtimeId");
    if ((kind !== "durable" && kind !== "expiring") || typeof projectId !== "string" || typeof runtimeId !== "string") {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 502);
    }
    if (kind === "durable") {
        return { kind, projectId, runtimeId };
    }
    const expiresAtEpochMilliseconds = Reflect.get(value, "expiresAtEpochMilliseconds");
    if (typeof expiresAtEpochMilliseconds !== "number" || !Number.isSafeInteger(expiresAtEpochMilliseconds)) {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 502);
    }
    return { expiresAtEpochMilliseconds, kind, projectId, runtimeId };
}

export async function subscribeToLiveEvents(
    request: Request,
    receive: SessionEventReceiver,
    signal: AbortSignal,
    dispatch: (request: Request) => Promise<Response>,
    environment: StandaloneRelayBindings,
    receiverFactory: LiveSessionEventReceiverFactory,
): Promise<{ readonly unsubscribe: () => Promise<void> }> {
    const path = new URL(request.url).pathname;
    const prefix = `${MOBIUS_API_PREFIX}/v1/projects/`;
    const segments = path.slice(prefix.length).split("/");
    if (!path.startsWith(prefix) || segments.length !== 4 || segments[1] !== "sessions") {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 400);
    }
    const sessionId = segments[2];
    if (sessionId === undefined) {
        throw new LiveEventSubscriptionError("invalid_subscription_target", "The Session event target is invalid", 400);
    }
    const target = await decodeLiveEventTarget(await dispatch(request));
    signal.throwIfAborted();
    const id = environment.SESSION_RELAY.idFromName(`standalone:${target.projectId}:${sessionId}`);
    const stub = environment.SESSION_RELAY.get(id);
    const subscriptionId = crypto.randomUUID();
    let resolveReady = (): void => undefined;
    let rejectReady = (_cause: unknown): void => undefined;
    const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const receiver = receiverFactory.create({
        receive: async (message) => {
            await receive.receive(message);
            if (message.kind === "ready") {
                resolveReady();
            }
        },
    });
    const operation = stub.subscribeToLiveSessionEvents(
        subscriptionId,
        target.projectId,
        target.runtimeId,
        sessionId,
        receiver,
    );
    let state: { readonly kind: "opening" } | { readonly kind: "open" } | { readonly kind: "closed" } = {
        kind: "opening",
    };
    void operation.catch((cause: unknown) => {
        switch (state.kind) {
            case "opening":
                rejectReady(cause);
                return;
            case "open":
                state = { kind: "closed" };
                void receive.receive({ kind: "end" }).catch(() => undefined);
                return;
            case "closed":
                return;
        }
    });
    await ready;
    if (state.kind === "opening") {
        state = { kind: "open" };
    }
    const unsubscribe = async (): Promise<void> => {
        switch (state.kind) {
            case "opening":
            case "open":
                state = { kind: "closed" };
                await stub.unsubscribeFromLiveSessionEvents(subscriptionId);
                await operation;
                return;
            case "closed":
                return;
        }
    };
    const timer =
        target.kind === "expiring"
            ? setTimeout(
                  () => void unsubscribe().catch(() => undefined),
                  Math.max(0, target.expiresAtEpochMilliseconds - Date.now()),
              )
            : null;
    return {
        unsubscribe: async () => {
            if (timer !== null) {
                clearTimeout(timer);
            }
            await unsubscribe();
        },
    };
}
