import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { expect, test } from "vitest";
import { createAcpClient } from "../../src/engine/acp/connection/create-client.ts";
import { CodexAcpAgent } from "../../src/engine/acp/harness/codex/agent.ts";
import type { CodexSessionUpdate } from "../../src/engine/acp/harness/codex/session-update.ts";
import { ControlledCodexFixture } from "../support/agents/controlled-codex.ts";

const MESSAGE_ID = "async-question-message";

function agentMessage(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return { id: MESSAGE_ID, memoryCitation: null, phase: "final_answer", type: "agentMessage", ...fields };
}

/** Starts a session, runs `scenario` against it, and returns what the client was shown for the message. */
async function shownMessage(
    fixtureOptions: Parameters<typeof ControlledCodexFixture.create>[0],
    scenario: (
        connection: ReturnType<ReturnType<typeof createAcpClient>["connect"]>,
        signal: AbortSignal,
    ) => Promise<void>,
): Promise<string> {
    await using fixture = await ControlledCodexFixture.create(fixtureOptions);
    const updates: CodexSessionUpdate[] = [];
    const endpoint = new CodexAcpAgent({
        command: fixture.environment["MOBIUS_CODEX_PATH"] ?? "",
        cwd: process.cwd(),
        environment: fixture.environment,
        onSessionUpdate: async ({ update }) => {
            updates.push(update);
        },
    });
    const connection = createAcpClient({
        onUpdate: async () => undefined,
        onPermission: async () => {
            throw new Error("Unexpected permission request");
        },
        onElicitation: async () => {
            throw new Error("Unexpected input request");
        },
        onElicitationComplete: async () => undefined,
    }).connect(endpoint.app());
    const signal = AbortSignal.timeout(30_000);
    try {
        await endpoint.initialize(signal);
        await connection.agent.request(
            methods.agent.initialize,
            { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} },
            { cancellationSignal: signal },
        );
        await scenario(connection, signal);
        return updates
            .flatMap((update) =>
                update.sessionUpdate === "agent_message_chunk" &&
                update.messageId === MESSAGE_ID &&
                update.content.type === "text"
                    ? [update.content.text]
                    : [],
            )
            .join("");
    } finally {
        await endpoint.close();
        connection.close();
    }
}

/** A live turn in which Codex emits `message`. */
function liveTurn(
    message: Readonly<Record<string, unknown>>,
    options: { readonly streamed?: boolean } = {},
): Promise<string> {
    return shownMessage(
        { agentMessage: message, streamAgentMessage: options.streamed === true },
        async (connection, signal) => {
            const session = await connection.agent.request(
                methods.agent.session.new,
                { cwd: process.cwd(), mcpServers: [] },
                { cancellationSignal: signal },
            );
            await connection.agent.request(
                methods.agent.session.prompt,
                { sessionId: session.sessionId, prompt: [{ type: "text", text: "Build the storage layer" }] },
                { cancellationSignal: signal },
            );
        },
    );
}

const asyncQuestions = {
    delivery: "async",
    questions: [
        { options: ["Postgres", "SQLite"], title: "Which database should I use?" },
        { options: null, title: "What should the schema be called?" },
    ],
};

test("Given Codex asks an asynchronous question, When the turn runs, Then the user sees the question and every option", async () => {
    const text = await liveTurn(agentMessage({ ...asyncQuestions, text: "I need two decisions before continuing." }));

    expect(text).toBe(
        [
            "I need two decisions before continuing.",
            "",
            "**Which database should I use?**",
            "- Postgres",
            "- SQLite",
            "",
            "**What should the schema be called?**",
        ].join("\n"),
    );
});

test("Given Codex sends only the question list, When the turn runs, Then the message is not empty", async () => {
    const text = await liveTurn(agentMessage({ ...asyncQuestions, text: "" }));

    expect(text).toBe(
        [
            "**Which database should I use?**",
            "- Postgres",
            "- SQLite",
            "",
            "**What should the schema be called?**",
        ].join("\n"),
    );
});

test("Given the message text already presents a question and its options, When the turn runs, Then it is not repeated", async () => {
    const written = "Which database should I use?\n1. Postgres\n2. SQLite";
    const text = await liveTurn(agentMessage({ ...asyncQuestions, text: written }));

    expect(text).toBe([written, "", "**What should the schema be called?**"].join("\n"));
});

test("Given Codex streams the message text before its questions, When the turn runs, Then the questions follow the streamed text", async () => {
    const text = await liveTurn(agentMessage({ ...asyncQuestions, text: "I need two decisions." }), { streamed: true });

    expect(text).toBe(
        [
            "I need two decisions.",
            "",
            "**Which database should I use?**",
            "- Postgres",
            "- SQLite",
            "",
            "**What should the schema be called?**",
        ].join("\n"),
    );
});

test("Given Codex sends a question list this Mobius cannot read, When the turn runs, Then the message text is still delivered", async () => {
    const text = await liveTurn(
        agentMessage({
            delivery: "async",
            questions: [{ prompt: "A shape from a newer Codex", choices: 3 }],
            text: "Still readable",
        }),
    );

    expect(text).toBe("Still readable");
});

test("Given a saved thread whose message asked a question, When the session is loaded, Then the replayed history includes its options", async () => {
    const text = await shownMessage(
        { savedAgentMessage: agentMessage({ ...asyncQuestions, text: "I need two decisions." }) },
        async (connection, signal) => {
            await connection.agent.request(
                methods.agent.session.load,
                { sessionId: "saved-thread", cwd: process.cwd(), mcpServers: [] },
                { cancellationSignal: signal },
            );
        },
    );

    expect(text).toBe(
        [
            "I need two decisions.",
            "",
            "**Which database should I use?**",
            "- Postgres",
            "- SQLite",
            "",
            "**What should the schema be called?**",
        ].join("\n"),
    );
});
