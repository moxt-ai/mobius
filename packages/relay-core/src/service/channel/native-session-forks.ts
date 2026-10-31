import type { ForkMobiusNativeSessionRequest } from "@moxt-ai/mobius-sdk";
import {
    decodeNativeSessionRequest,
    decodeNativeSessionResult,
    decodeSessionQueryCommand,
    decodeSessionRestoreCommand,
    RUNTIME_WORKSPACE_BINDING_ID,
} from "@moxt-ai/mobius-sdk/protocol";
import { type ProjectScope, RuntimeOperationFailedError } from "../../entity/do/session.ts";
import { hashSecret, PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { SessionRuntimeOperations } from "../../gateway/session-runtime-operations.ts";
import type { NativeSessionForkStorage } from "../../storage/native-session-fork-storage.ts";

function forkResult(value: string) {
    const result = decodeNativeSessionResult(value);
    if (result.action !== "fork" || result.ready.sessionId !== result.targetSessionId) {
        throw new PairingDirectoryError("invalid_native_session_response", "The Runtime returned an invalid Fork");
    }
    return result;
}

function forkReceipt(value: string) {
    const encoded: unknown = JSON.parse(value);
    if (typeof encoded !== "object" || encoded === null || !("source" in encoded) || !("result" in encoded)) {
        throw new PairingDirectoryError("invalid_native_session_response", "The Fork receipt is invalid");
    }
    const source = decodeNativeSessionResult(JSON.stringify(encoded.source));
    if (source.action !== "find") {
        throw new PairingDirectoryError("invalid_native_session_response", "The Fork source is invalid");
    }
    return { source, result: forkResult(JSON.stringify(encoded.result)) };
}

function unknownOutcome(cause?: unknown): PairingDirectoryError {
    return new PairingDirectoryError(
        "native_fork_outcome_unknown",
        "The Fork outcome is unknown. Check local sessions before starting another Fork.",
        { cause },
    );
}

async function waitForFork<T>(completion: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void completion.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}

/** Only this service may start or complete a native Fork receipt. */
export class NativeSessionForks {
    readonly #storage: NativeSessionForkStorage;
    readonly #waitUntil: (operation: Promise<void>) => void;
    readonly #running = new Map<
        string,
        { readonly requestHash: string; readonly completion: Promise<ReturnType<typeof forkReceipt>> }
    >();

    constructor(storage: NativeSessionForkStorage, waitUntil: (operation: Promise<void>) => void) {
        this.#storage = storage;
        this.#waitUntil = waitUntil;
    }

    async #recover(
        scope: ProjectScope,
        runtimeId: string,
        input: ForkMobiusNativeSessionRequest,
        attemptJson: string,
        request: SessionRuntimeOperations["requestProjectScopeControl"],
        signal: AbortSignal,
    ) {
        try {
            const encoded: unknown = JSON.parse(attemptJson);
            if (
                typeof encoded !== "object" ||
                encoded === null ||
                !("source" in encoded) ||
                !("targetSessionId" in encoded)
            ) {
                throw unknownOutcome();
            }
            const source = decodeNativeSessionResult(JSON.stringify(encoded.source));
            if (source.action !== "find" || source.entry.nativeSessionId !== input.nativeSessionId) {
                throw unknownOutcome();
            }
            const restore = decodeSessionRestoreCommand(
                JSON.stringify({
                    kind: "session.restore",
                    requestId: crypto.randomUUID(),
                    sessionId: encoded.targetSessionId,
                }),
            );
            // Restore only an existing committed Session. Unlike prepare, this cannot create a missing target.
            const restored = await request(scope, runtimeId, restore, signal);
            if (
                restored.kind !== "session.restored" ||
                restored.entry.sessionId !== restore.sessionId ||
                !restored.entry.prompted ||
                restored.ready.sessionId !== restore.sessionId ||
                restored.ready.agentId !== input.agentId ||
                restored.entry.agentId !== input.agentId ||
                restored.ready.directoryId !== source.entry.directoryId ||
                JSON.stringify(restored.ready.additionalDirectories.map((directory) => directory.directoryId)) !==
                    JSON.stringify(source.entry.additionalDirectories.map((directory) => directory.directoryId))
            ) {
                throw unknownOutcome();
            }
            const result = forkResult(
                JSON.stringify({
                    kind: "native.session.result",
                    action: "fork",
                    requestId: restore.requestId,
                    sessionId: source.sessionId,
                    targetSessionId: restore.sessionId,
                    ready: restored.ready,
                    title: restored.entry.title,
                }),
            );
            return { source, result };
        } catch (cause) {
            throw unknownOutcome(cause);
        }
    }

    /** Whether a Runtime that has finished handling a Fork command holds no Session for its target. */
    async #targetAbsent(
        scope: ProjectScope,
        runtimeId: string,
        targetSessionId: string,
        request: SessionRuntimeOperations["requestProjectScopeControl"],
        signal: AbortSignal,
    ) {
        try {
            const queried = await request(
                scope,
                runtimeId,
                decodeSessionQueryCommand(
                    JSON.stringify({
                        kind: "session.query",
                        requestId: crypto.randomUUID(),
                        sessionIds: [targetSessionId],
                    }),
                ),
                signal,
            );
            return (
                queried.kind === "session.queried" &&
                queried.entries.every((entry) => entry.sessionId !== targetSessionId)
            );
        } catch {
            // Without an answer the target may exist, so the Fork outcome stays unknown.
            return false;
        }
    }

    readonly fork = async (
        scope: ProjectScope,
        runtimeId: string,
        operationId: string,
        input: ForkMobiusNativeSessionRequest,
        request: SessionRuntimeOperations["requestProjectScopeControl"],
        signal: AbortSignal,
    ) => {
        const requestHash = await hashSecret(
            JSON.stringify([input.agentId, input.nativeSessionId, input.directoryId, input.additionalDirectoryIds]),
        );
        signal.throwIfAborted();
        const key = JSON.stringify([scope.projectId, operationId]);
        const prior = this.#storage.read(scope.projectId, operationId);
        const running = this.#running.get(key);
        if (
            (prior !== undefined && prior.requestHash !== requestHash) ||
            (running !== undefined && running.requestHash !== requestHash)
        ) {
            throw new PairingDirectoryError("idempotency_conflict", "This Fork operation has different inputs");
        }
        if (prior !== undefined && prior.resultJson !== null) {
            return forkReceipt(prior.resultJson);
        }
        if (running !== undefined) {
            return await waitForFork(running.completion, signal);
        }
        if (prior !== undefined && prior.attemptJson === null) {
            // Legacy receipts cannot identify the target. Never turn an unknown attempt into another Fork.
            throw unknownOutcome();
        }
        // Share the whole bounded operation, including lookup. Disconnecting one HTTP waiter only cancels its wait.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new DOMException("Fork timed out", "TimeoutError")), 120_000);
        const completion = Promise.resolve().then(async () => {
            try {
                if (prior !== undefined) {
                    const receipt = await this.#recover(
                        scope,
                        runtimeId,
                        input,
                        prior.attemptJson ?? "null",
                        request,
                        controller.signal,
                    );
                    this.#storage.complete(scope.projectId, operationId, JSON.stringify(receipt));
                    return receipt;
                }
                // Resolve and authorize the native identity before recording any possible side effect.
                const found = await request(
                    scope,
                    runtimeId,
                    decodeNativeSessionRequest(
                        JSON.stringify({
                            ...input,
                            action: "find",
                            kind: "native.session.request",
                            bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                            requestId: crypto.randomUUID(),
                            sessionId: crypto.randomUUID(),
                        }),
                    ),
                    controller.signal,
                );
                if (
                    found.kind !== "native.session.result" ||
                    found.action !== "find" ||
                    found.entry.nativeSessionId !== input.nativeSessionId
                ) {
                    throw new PairingDirectoryError(
                        "invalid_native_session_response",
                        "The native session could not be found",
                    );
                }
                controller.signal.throwIfAborted();
                const command = decodeNativeSessionRequest(
                    JSON.stringify({
                        kind: "native.session.request",
                        action: "fork",
                        agentId: input.agentId,
                        bindingId: RUNTIME_WORKSPACE_BINDING_ID,
                        directoryId: found.entry.directoryId,
                        additionalDirectoryIds: found.entry.additionalDirectories.map(
                            (directory) => directory.directoryId,
                        ),
                        requestId: crypto.randomUUID(),
                        sessionId: found.sessionId,
                        entryId: found.entry.entryId,
                        targetSessionId: crypto.randomUUID(),
                    }),
                );
                if (command.action !== "fork") {
                    throw new PairingDirectoryError("invalid_request", "The Fork request is invalid");
                }
                this.#storage.start(
                    scope.projectId,
                    operationId,
                    requestHash,
                    JSON.stringify({
                        source: found,
                        targetSessionId: command.targetSessionId,
                    }),
                );
                try {
                    const result = forkResult(
                        JSON.stringify(await request(scope, runtimeId, command, controller.signal)),
                    );
                    if (result.targetSessionId !== command.targetSessionId || result.ready.agentId !== input.agentId) {
                        throw new PairingDirectoryError(
                            "invalid_native_session_response",
                            "The Fork target is invalid",
                        );
                    }
                    const receipt = { source: found, result };
                    this.#storage.complete(scope.projectId, operationId, JSON.stringify(receipt));
                    return receipt;
                } catch (cause) {
                    // The Runtime's own failure reply is final only without a target: it can still report an abort
                    // after committing one. A rejected Fork created no Session, so forget it and let it run again.
                    if (
                        cause instanceof RuntimeOperationFailedError &&
                        (await this.#targetAbsent(
                            scope,
                            runtimeId,
                            command.targetSessionId,
                            request,
                            controller.signal,
                        ))
                    ) {
                        this.#storage.abandon(scope.projectId, operationId);
                        throw cause;
                    }
                    throw unknownOutcome(cause);
                }
            } finally {
                clearTimeout(timer);
                this.#running.delete(key);
            }
        });
        this.#running.set(key, { requestHash, completion });
        this.#waitUntil(
            completion.then(
                () => undefined,
                () => undefined,
            ),
        );
        return await waitForFork(completion, signal);
    };
}
