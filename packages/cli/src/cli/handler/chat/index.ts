import type { Command } from "commander";
import { openMobiusCliInstallation } from "../../../daemon/pairing/pair-local-machine.ts";
import { connectLocalSession } from "../../../runtime/local/session-client.ts";
import { LocalSessionError } from "../../../runtime/local/session-stream.ts";
import type { CliContext } from "../../context.ts";
import { runTerminalSession } from "./terminal-session.ts";

interface ChatOptions {
    readonly runtime: string;
    readonly session: string;
    readonly prompt?: string;
    readonly json?: boolean;
}

export function registerChatCommand(program: Command, context: CliContext): void {
    program
        .command("chat")
        .description("connect this terminal to the same session open in Morty")
        .requiredOption("--runtime <runtime-id>", "connected machine identifier shown in Morty")
        .requiredOption("--session <session-id>", "session identifier shown in Morty")
        .option("--prompt <text>", "send one prompt, wait for completion, then disconnect")
        .option("--json", "print validated daemon messages as newline-delimited JSON")
        .action(async (options: ChatOptions) => {
            const signal =
                options.prompt === undefined
                    ? context.shutdownSignal
                    : AbortSignal.any([context.shutdownSignal, AbortSignal.timeout(3_600_000)]);
            const installation = await openMobiusCliInstallation(signal, process.env);
            const connections = await installation.listConnections(signal);
            const matches = connections.filter(
                (connection) => connection.runtimeId === options.runtime && connection.activation === "active",
            );
            const connection = matches.length === 1 ? matches[0] : undefined;
            if (connection === undefined) {
                throw new LocalSessionError(
                    "local_session_runtime_unavailable",
                    "Connect this machine to Morty and copy its terminal command again",
                );
            }
            await using session = await connectLocalSession(
                {
                    stateDirectory: installation.stateDirectory,
                    channelId: connection.channelId,
                    sessionId: options.session,
                },
                signal,
            );
            await runTerminalSession(session, options, signal);
        });
}
