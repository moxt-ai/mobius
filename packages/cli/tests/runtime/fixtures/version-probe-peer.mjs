import { fork } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const scenario = process.env.MOBIUS_TEST_PROBE_SCENARIO;
const secret = "private-probe-output-with-credential";
if (process.argv.includes("--write-version")) {
    process.once("disconnect", () => {
        const endpoint = new URL(process.env.MOBIUS_TEST_PROBE_CONTROL);
        endpoint.searchParams.set("pid", String(process.pid));
        request(endpoint, (response) => {
            response.resume();
            response.once("end", () => {
                const output = scenario === "limit" ? secret.repeat(1024) : "codex-cli 0.154.0\n";
                const stream = process.env.MOBIUS_TEST_PROBE_STREAM === "stderr" ? process.stderr : process.stdout;
                stream.write(output);
            });
        }).end();
    });
    process.send("ready");
} else if (process.argv.includes("--version")) {
    if (scenario === "empty") {
        process.exit(0);
    } else if (scenario === "nonzero") {
        process.stderr.write(secret);
        process.exitCode = 7;
    } else if (scenario === "adapter-empty") {
        const marker = process.env.MOBIUS_TEST_PROBE_STATE;
        if (!existsSync(marker)) {
            writeFileSync(marker, "agent-version-read");
            process.stdout.write("codex-cli 0.154.0\n");
        }
    } else if (scenario === "readiness-failure") {
        process.stdout.write("codex-cli 0.154.0\n");
    } else {
        const writer = fork(fileURLToPath(import.meta.url), ["--write-version"], {
            stdio: ["ignore", 1, 2, "ipc"],
        });
        writer.once("message", () => process.exit(scenario === "nonzero-held" ? 7 : 0));
    }
} else {
    createInterface({ input: process.stdin }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.id === undefined) {
            return;
        }
        if (scenario === "readiness-failure") {
            process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32603, message: secret } })}\n`);
            return;
        }
        const result =
            message.method === "thread/start"
                ? { thread: { id: `probe-thread-${process.pid}` } }
                : message.method === "model/list"
                  ? { data: [], nextCursor: null }
                  : {};
        process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    });
}
