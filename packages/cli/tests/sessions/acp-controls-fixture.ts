import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpContentExternalizer } from "../../src/acp/content/content-externalizer.ts";
import { MemorySessionStore } from "../../src/session/record/session-store.ts";
import { systemTimer } from "../../src/util/timer.ts";
import { acpAdapters } from "../support/acp-adapters.ts";
import { SessionRuntimeFixture as SessionManager } from "../support/session-runtime.ts";
import { UnretainedExternalContentStore } from "../support/unretained-external-content-store.ts";
import { fakeAgent, RecordingObserver } from "./acp-feature-fixture.ts";

/** Owns an isolated ACP process and its disposable native files. */
export async function createControlledSession() {
    const directory = await mkdtemp(join(tmpdir(), "mobius-acp-controls-"));
    const observer = new RecordingObserver();
    const manager = new SessionManager({
        observer,
        store: new MemorySessionStore(),
        adapters: acpAdapters,
        sessionIdentity: "assigned",
        onSessionStatusChanged: () => undefined,
        contentExternalizer: new AcpContentExternalizer((sessionId, content, signal) =>
            new UnretainedExternalContentStore().put({
                bytes: content.bytes,
                kind: content.kind,
                mediaType: content.mediaType,
                name: content.name,
                sessionId,
                signal,
            }),
        ),
        timer: systemTimer,
        maxProcesses: null,
    });
    const cancellation = new AbortController();
    try {
        const shared = join(directory, "shared");
        await mkdir(shared);
        return {
            manager,
            observer,
            request: {
                additionalDirectories: [shared],
                agent: fakeAgent([], { MOBIUS_FAKE_ACP_STATE_DIRECTORY: directory }),
                cwd: directory,
                sessionId: "controls-session",
                signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]),
            },
            [Symbol.asyncDispose]: async () => {
                cancellation.abort();
                try {
                    await manager.close();
                } finally {
                    await rm(directory, { recursive: true, force: true });
                }
            },
        };
    } catch (cause) {
        cancellation.abort();
        try {
            await manager.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
        throw cause;
    }
}

/** Drive the controlled peer's permission/form dialogue through production ports. */
export async function completeAcpControls(session: Awaited<ReturnType<typeof createControlledSession>>) {
    const running = session.manager.runPrompt({
        ...session.request,
        commandId: "controls-command",
        prompt: "exercise ACP controls",
        images: [{ data: "aW1hZ2U=", mimeType: "image/png", name: "preview.png" }],
        lifecycle: {
            attemptId: "controls-attempt",
            content: [{ text: "exercise ACP controls", type: "text" }],
            epoch: "controls-epoch",
        },
        resources: [
            {
                type: "embedded",
                mimeType: "text/plain",
                text: "supporting context",
                uri: "mobius://upload/context.txt",
            },
        ],
    });
    // Observe startup failure while waiting for an interaction, rather than timing out later.
    const finishedBeforeInteraction = running.then(() => {
        throw new Error("The controlled ACP prompt completed before its expected interaction");
    });
    const permission = await Promise.race([session.observer.permissionArrived.promise, finishedBeforeInteraction]);
    await session.manager.respondPermission({
        interactionId: permission.interactionId,
        optionId: "allow-once",
        outcome: "selected",
        sessionId: session.request.sessionId,
    });
    const elicitation = await Promise.race([session.observer.elicitationArrived.promise, finishedBeforeInteraction]);
    await session.manager.respondElicitation({
        action: "accept",
        content: JSON.stringify({ branch: "main" }),
        interactionId: elicitation.interactionId,
        sessionId: session.request.sessionId,
    });
    return { permission, elicitation, completed: await running, text: session.observer.agentText() };
}
