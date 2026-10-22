import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";

import { expect, test } from "vitest";

import { AgentRuntimeManager, acpAdapters } from "../../src/acp/agent-runtime-manager.ts";
import { AcpContentExternalizer } from "../../src/acp/external-content/acp-content-externalizer.ts";
import { UnretainedExternalContentStore } from "../../src/acp/external-content/local-external-content-store.ts";
import { type AcpPrepareOptions, NullAcpSessionObserver } from "../../src/acp/session-contracts.ts";
import { MemoryAcpSessionStore } from "../../src/acp/session-store.ts";
import { InProcessAcpAgentDefinition } from "../../src/runtime/config.ts";
import type { ScheduledTask, Timer } from "../../src/runtime/relay/timer.ts";
import { ControlledSessionAgent } from "../support/agents/controlled-session-agent.ts";

const IDLE_MILLISECONDS = 1_000;
// A Session close that has not finished after this long reports a typed timeout.
const CLOSE_DEADLINE_MILLISECONDS = 30_000;

/** A clock the scenario moves by hand; scheduled tasks run synchronously once their time has passed. */
class ManualTimer implements Timer {
    #now = 0;
    #sequence = 0;
    readonly #tasks = new Map<number, { readonly callback: () => void; readonly dueAt: number }>();

    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const id = this.#sequence;
        this.#sequence += 1;
        this.#tasks.set(id, { callback, dueAt: this.#now + milliseconds });
        return {
            cancel: () => {
                this.#tasks.delete(id);
            },
        };
    };

    readonly advance = (milliseconds: number): void => {
        const target = this.#now + milliseconds;
        for (;;) {
            const [due] = [...this.#tasks.entries()]
                .filter(([, task]) => task.dueAt <= target)
                .toSorted(([, left], [, right]) => left.dueAt - right.dueAt);
            if (due === undefined) {
                break;
            }
            const [id, task] = due;
            this.#tasks.delete(id);
            this.#now = task.dueAt;
            task.callback();
        }
        this.#now = target;
    };
}

type Outcome<Value> =
    | { readonly kind: "resolved"; readonly value: Value }
    | { readonly kind: "rejected"; readonly error: unknown };

/** Reports how an operation ended without leaving a rejection unhandled while the scenario moves on. */
function settle<Value>(operation: Promise<Value>): Promise<Outcome<Value>> {
    return operation.then(
        (value): Outcome<Value> => ({ kind: "resolved", value }),
        (error: unknown): Outcome<Value> => ({ kind: "rejected", error }),
    );
}

interface IdleFixture {
    readonly agent: ControlledSessionAgent;
    readonly manager: AgentRuntimeManager;
    readonly timer: ManualTimer;
    /** Options that address one Session of the controlled Agent. */
    readonly session: (sessionId: string) => AcpPrepareOptions;
}

/**
 * Runs the Session manager the way the daemon builds it. Sessions use native identity, and the controlled
 * Agent takes a native chat Agent id, so a UUID Session id is the Agent's own Session id.
 */
async function withIdleManager(scenario: (fixture: IdleFixture) => Promise<void>): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), "mobius-idle-expiry-"));
    const agent = new ControlledSessionAgent();
    const timer = new ManualTimer();
    const store = new MemoryAcpSessionStore();
    const definition = new InProcessAcpAgentDefinition(
        "claude",
        "Controlled Claude",
        process.execPath,
        agent.createEndpoint,
        {},
        "1.0.0",
    );
    const signal = new AbortController().signal;
    const manager = new AgentRuntimeManager({
        observer: new NullAcpSessionObserver(),
        store,
        adapters: acpAdapters,
        sessionIdentity: "native",
        onSessionStatusChanged: () => undefined,
        contentExternalizer: new AcpContentExternalizer(new UnretainedExternalContentStore()),
        timer,
        maxProcesses: null,
        processIdleMilliseconds: IDLE_MILLISECONDS,
    });
    try {
        await scenario({
            agent,
            manager,
            timer,
            session: (sessionId) => ({
                additionalDirectories: [],
                agent: definition,
                cwd: workspace,
                sessionId,
                signal,
            }),
        });
    } finally {
        agent.releaseAll();
        // A close that missed its deadline keeps its bookkeeping until the stuck teardown has ended.
        await nextTurn();
        await manager.close();
        store.close();
        await rm(workspace, { force: true, recursive: true });
    }
}

const operationsOf = (agent: ControlledSessionAgent): string[] =>
    agent.operations.map(({ endpoint, method }) => `${endpoint.toString()} ${method}`);

test("Given a native Session that its first prompt titled, When its Agent process expires from idleness and the Session is prepared again, Then the stored Session keeps its title", async () => {
    await withIdleManager(async ({ agent, manager, session, timer }) => {
        const sessionId = crypto.randomUUID();
        await manager.prepareSession(session(sessionId));
        await manager.runPrompt({
            ...session(sessionId),
            commandId: crypto.randomUUID(),
            images: [],
            prompt: "Plan the release",
            resources: [],
        });

        timer.advance(IDLE_MILLISECONDS);
        await agent.endpoint(0).terminated;
        await manager.prepareSession(session(sessionId));

        expect(manager.findSessions([sessionId])).toEqual([
            expect.objectContaining({ prompted: true, sessionId, title: "Plan the release" }),
        ]);
        expect(operationsOf(agent)).toEqual([
            "0 session/resume",
            "0 session/prompt",
            "0 session/close",
            "1 session/resume",
        ]);
    });
});

test("Given an idle Agent process whose teardown has not finished, When a prompt is prepared and the close deadline passes, Then the preparation reports the typed close timeout and no second process starts", async () => {
    await withIdleManager(async ({ agent, manager, session, timer }) => {
        const sessionId = crypto.randomUUID();
        await manager.prepareSession(session(sessionId));
        const teardown = agent.closes.hold();

        timer.advance(IDLE_MILLISECONDS);
        await teardown.entered;
        const preparation = settle(manager.prepareExecutionSession(session(sessionId)));
        timer.advance(CLOSE_DEADLINE_MILLISECONDS);

        expect(await preparation).toEqual({
            kind: "rejected",
            error: expect.objectContaining({ code: "session_close_timeout" }),
        });
        expect(agent.endpointCount()).toBe(1);

        teardown.release();
        await agent.endpoint(0).terminated;
    });
});

test("Given a Session rename that is waiting on its Agent, When the idle period passes, Then the Agent process stays open until the period passes after the rename", async () => {
    await withIdleManager(async ({ agent, manager, session, timer }) => {
        const sessionId = crypto.randomUUID();
        await manager.prepareSession(session(sessionId));
        timer.advance(IDLE_MILLISECONDS / 2);
        const rename = agent.renames.hold();

        const renamed = settle(manager.renameSession(sessionId, "Release plan", new AbortController().signal));
        await rename.entered;
        timer.advance(IDLE_MILLISECONDS + IDLE_MILLISECONDS / 10);
        await nextTurn();
        expect(operationsOf(agent)).toEqual(["0 session/resume", "0 _session/rename"]);

        rename.release();
        expect(await renamed).toEqual({
            kind: "resolved",
            value: expect.objectContaining({ title: "Release plan" }),
        });

        timer.advance(IDLE_MILLISECONDS);
        await agent.endpoint(0).terminated;
        expect(operationsOf(agent)).toEqual(["0 session/resume", "0 _session/rename", "0 session/close"]);
    });
});
