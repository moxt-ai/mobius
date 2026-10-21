import type { Command } from "commander";

import type { CliContext } from "../../context.ts";
import { collectLocalDaemonLogs, defaultStateDirectory, type LocalLogEntry } from "./logic/collect-local-logs.ts";

interface LogsOptions {
    readonly json?: boolean;
    readonly stateDirectory?: string;
    readonly tail?: string;
}

const DEFAULT_TAIL_LINES = 200;
const MAXIMUM_TAIL_LINES = 2_000;

const SHARING_NOTICE = "These logs may contain local paths and Agent output. Review them before sharing.\n";

export function registerLogsCommand(program: Command, context: CliContext): void {
    program
        .command("logs")
        .description("print the local daemon diagnostic logs for a bug report")
        .option("--json", "write the collected logs as JSON")
        .option("--state-directory <path>", "read logs from a specific Mobius state directory")
        .option(
            "--tail <lines>",
            `keep at most this many lines per log file (default ${DEFAULT_TAIL_LINES.toString()})`,
        )
        .action(async (options: LogsOptions) => {
            const tailLines = parseTailLines(options.tail);
            const json = options.json === true;
            const stateDirectory = options.stateDirectory?.trim() ?? defaultStateDirectory(process.env);
            const logs = await collectLocalDaemonLogs(stateDirectory, tailLines, context.shutdownSignal);
            // Keep stdout machine-parseable in JSON mode: the sharing notice is a
            // human warning, so it goes to stderr where it cannot corrupt a pipe.
            if (json) {
                process.stderr.write(SHARING_NOTICE);
                process.stdout.write(`${JSON.stringify(logs, null, 2)}\n`);
                return;
            }
            if (logs.length === 0) {
                process.stdout.write("No local daemon logs were found.\n");
                return;
            }
            process.stdout.write(formatText(logs));
        });
}

function parseTailLines(raw: string | undefined): number {
    if (raw === undefined) {
        return DEFAULT_TAIL_LINES;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("--tail requires a positive whole number of lines");
    }
    return Math.min(parsed, MAXIMUM_TAIL_LINES);
}

function formatText(logs: readonly LocalLogEntry[]): string {
    const sections = logs.map((log) => {
        const omitted = log.omittedLines === 0 ? "" : `# ${log.omittedLines.toString()} earlier line(s) omitted\n`;
        return `## ${log.path}\n${omitted}${log.lines.join("\n")}\n`;
    });
    return `${SHARING_NOTICE}\n${sections.join("\n")}`;
}
