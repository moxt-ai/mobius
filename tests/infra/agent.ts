import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAgentDefinition } from "../../packages/cli/src/agent-catalog/local-agent.ts";

/** A stateful ACP process replaces the hosted provider, keeping Runtime execution real. */
export async function createTestAgent(options: { readonly signal: AbortSignal }) {
    options.signal.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "mobius-test-agent-"));
    try {
        const workspace = join(directory, "workspace");
        const native = join(directory, "native");
        await Promise.all([mkdir(workspace), mkdir(native)]);
        options.signal.throwIfAborted();
        const implementation = fileURLToPath(
            new URL("./cli.ts", import.meta.resolve("@moxt-ai/mobius-fake-acp-agent")),
        );
        const definition = new LocalAgentDefinition(
            "codex",
            "Codex",
            process.execPath,
            [implementation, "--agent-name", "Codex"],
            { MOBIUS_FAKE_ACP_STATE_DIRECTORY: native },
            "test-1",
            "test-1",
        );
        return { definition, workspace, [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }) };
    } catch (cause) {
        await rm(directory, { recursive: true, force: true });
        throw cause;
    }
}
