import { readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { WorkspaceDirectoryService } from "../authorization/workspace-directory.ts";
import { resumeMobiusRuntime } from "../pairing/pair-local-machine.ts";
import { readStateDirectory } from "../storage/state-directory.ts";
import { LocalBotAuthorizationError, LocalBotGrantStore } from "./local-bot-grant-store.ts";

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const argumentsSchema = z.union([
    z.tuple([z.literal("--bot"), identifier]),
    z.tuple([z.literal("--bot"), identifier, z.literal("--channel"), identifier]),
]);

export async function executeBotApproveCommand(
    arguments_: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    parent: AbortSignal,
): Promise<string> {
    const parsed = argumentsSchema.safeParse(arguments_);
    if (!parsed.success) {
        throw new LocalBotAuthorizationError(
            "invalid_arguments",
            "Usage: mobius bot approve --bot <bot-id> [--channel <channel-id>]",
        );
    }
    const [, botId, , requestedChannel] = parsed.data;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(30_000)]);
    signal.throwIfAborted();
    try {
        const stateDirectory = await realpath(readStateDirectory(environment));
        const auditDirectory = await realpath(join(stateDirectory, "audit"));
        if (dirname(auditDirectory) !== stateDirectory) {
            throw new LocalBotAuthorizationError(
                "local_grant_invalid",
                "The local approval directory is outside the Mobius state directory",
            );
        }
        const channels: string[] = [];
        for (const entry of await readdir(auditDirectory, { withFileTypes: true })) {
            signal.throwIfAborted();
            if (!entry.isFile() || !entry.name.endsWith(".sqlite")) {
                continue;
            }
            const channelId = entry.name.slice(0, -7);
            if (
                !identifier.safeParse(channelId).success ||
                (requestedChannel !== undefined && requestedChannel !== channelId)
            ) {
                continue;
            }
            const databasePath = await realpath(join(auditDirectory, entry.name));
            if (dirname(databasePath) !== auditDirectory) {
                throw new LocalBotAuthorizationError(
                    "local_grant_invalid",
                    "The local approval database is outside the Mobius audit directory",
                );
            }
            if (LocalBotGrantStore.containsBot(databasePath, botId)) {
                channels.push(channelId);
            }
        }
        const channelId = channels[0];
        if (channelId === undefined) {
            throw new LocalBotAuthorizationError(
                "bot_not_found",
                "No saved approval for this Bot was found. Run this command on the machine hosting the Bot.",
            );
        }
        if (channels.length !== 1) {
            throw new LocalBotAuthorizationError(
                "binding_ambiguous",
                `This Bot has approvals in multiple local channels. Add --channel with the intended channel: ${channels.join(", ")}`,
            );
        }
        const { config } = await resumeMobiusRuntime(channelId, signal, environment);
        signal.throwIfAborted();
        const grants = new LocalBotGrantStore(config.auditDatabasePath);
        try {
            const approval = await grants.reapprove(
                botId,
                config.catalog,
                new WorkspaceDirectoryService(config.bindingId, config.defaultWorkspace),
                config.bindingId,
                Date.now(),
                signal,
            );
            return `Approved Bot ${botId}\nBinding: ${approval.bindingId}\nAgent: ${approval.agentRef}\nWorkspace: ${approval.workspacePath}\nKeep your daemon running and resend your message in the same Chat conversation.\n`;
        } finally {
            grants.close();
        }
    } catch (cause) {
        parent.throwIfAborted();
        if (signal.aborted) {
            throw new LocalBotAuthorizationError("approval_timeout", "Local Bot approval timed out", { cause });
        }
        if (cause instanceof LocalBotAuthorizationError) {
            throw cause;
        }
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            throw new LocalBotAuthorizationError(
                "bot_not_found",
                "No saved local approval or Runtime connection was found for this Bot",
                { cause },
            );
        }
        throw new LocalBotAuthorizationError(
            "local_approval_failed",
            "Local Bot approval failed. Check the saved Runtime connection and local Agent installation.",
            { cause },
        );
    }
}
