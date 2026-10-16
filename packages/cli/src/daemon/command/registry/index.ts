import type { ServiceToDaemonMessage } from "@moxt-ai/mobius-protocol";
import type { CommandContext } from "../context.ts";
import type { DaemonCommand } from "../definition.ts";
import { createAgentSettingsCommands } from "./agent-settings.ts";
import { fileReadCommand } from "./file-read/index.ts";
import { liveHistoryPageLoadCommand, previewHistoryPageLoadCommand } from "./history.ts";
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
    const commands: readonly DaemonCommand[] = [
        runtimeDiagnosticsCommand,
        runtimePingCommand,
        liveHistoryPageLoadCommand,
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
