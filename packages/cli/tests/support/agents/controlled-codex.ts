import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class ControlledCodexFixture implements AsyncDisposable {
    readonly environment: Readonly<Record<string, string>>;
    readonly #directory: string;

    private constructor(directory: string, executable: string) {
        this.#directory = directory;
        const missing = join(directory, "missing-agent");
        this.environment = Object.freeze({
            MOBIUS_CLAUDE_PATH: missing,
            MOBIUS_CODEX_PATH: executable,
            MOBIUS_PI_PATH: missing,
        });
    }

    static async create(options: { readonly holdTurn?: boolean } = {}): Promise<ControlledCodexFixture> {
        const directory = await mkdtemp(join(tmpdir(), "mobius-controlled-codex-"));
        const executable = join(directory, "codex.mjs");
        await writeFile(
            executable,
            `#!${process.execPath}
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
    process.stdout.write("codex-cli 0.154.0\\n");
    process.exit(0);
}
if (process.argv[2] !== "app-server") {
    process.exit(1);
}

let threadNumber = 0;
let turnNumber = 0;
let active;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "thread/start") {
        send({ id: request.id, result: { thread: { id: "controlled-thread-" + ++threadNumber } } });
        return;
    }
    if (request.method === "turn/start") {
        const threadId = request.params.threadId;
        const turn = { id: "controlled-turn-" + ++turnNumber, status: "inProgress" };
        active = { threadId, turn };
        send({ id: request.id, result: { turn } });
        send({ method: "item/started", params: { threadId, turnId: turn.id,
            item: { type: "userMessage", id: "controlled-user-" + turnNumber, content: request.params.input },
        } });
        send({ method: "thread/settings/updated", params: {
            threadId, threadSettings: { collaborationMode: { mode: "plan" } },
        } });
        if (!${options.holdTurn === true}) {
            send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } });
        }
        return;
    }
    if (request.method === "turn/steer") {
        send({ id: request.id, result: { turnId: active.turn.id } });
        return;
    }
    if (request.method === "turn/interrupt") {
        send({ id: request.id, result: {} });
        send({ method: "turn/completed", params: { threadId: active.threadId, turn: { ...active.turn, status: "interrupted" } } });
        return;
    }
    const result = request.method === "model/list" ? { data: [], nextCursor: null } : {};
    process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
});
`,
            { mode: 0o700 },
        );
        return new ControlledCodexFixture(directory, executable);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await rm(this.#directory, { force: true, recursive: true });
    }
}
