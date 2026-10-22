import type { ServiceToDaemonMessage } from "@moxt-ai/mobius-sdk/protocol";
import type { CommandContext } from "../context.ts";
import type { RuntimeCommand } from "../definition.ts";
import { createAgentSettingsCommands } from "./agent-settings.ts";
import { fileReadCommand } from "./file-read/index.ts";
import { previewHistoryPageLoadCommand, sessionHistoryPageLoadCommand } from "./history.ts";
import {
    elicitationRespondCommand,
    permissionRespondCommand,
    promptDispositionCommand,
    sessionCancelCommand,
    sessionCloseCommand,
} from "./interactions.ts";
import { createNativeSessionCommands } from "./native-sessions.ts";
import { sessionPromptCommand } from "./prompt.ts";
import { runtimeDiagnosticsCommand, runtimePingCommand } from "./runtime.ts";
import {
    sessionConfigReadCommand,
    sessionConfigureCommand,
    sessionPrepareCommand,
    sessionRenameCommand,
    sessionRestoreCommand,
    workspaceListCommand,
} from "./session.ts";

export function createCommandRegistry(context: CommandContext): {
    readonly dispatch: (message: ServiceToDaemonMessage) => void;
    readonly settle: () => Promise<void>;
} {
    const commands: readonly RuntimeCommand[] = [
        runtimeDiagnosticsCommand,
        runtimePingCommand,
        sessionHistoryPageLoadCommand,
        previewHistoryPageLoadCommand,
        ...createNativeSessionCommands(context),
        ...createAgentSettingsCommands(context),
        fileReadCommand,
        sessionCancelCommand,
        sessionCloseCommand,
        promptDispositionCommand,
        workspaceListCommand,
        sessionPrepareCommand,
        sessionConfigureCommand,
        sessionConfigReadCommand,
        sessionRenameCommand,
        sessionRestoreCommand,
        permissionRespondCommand,
        elicitationRespondCommand,
        sessionPromptCommand,
    ];
    return {
        dispatch: (message): void => {
            const command = commands.find((candidate) => candidate.kind === message.kind);
            if (command === undefined) {
                throw new Error("Unsupported protocol message");
            }
            command.handle(context, message);
        },
        settle: async (): Promise<void> => {
            await Promise.all(commands.flatMap((command) => (command.settle === undefined ? [] : [command.settle()])));
        },
    };
}
