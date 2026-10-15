import type { Command } from "commander";

import type { CliContext } from "../../context.ts";

export function registerVersionHandler(program: Command, context: CliContext): void {
    program
        .command("version", { hidden: true })
        .description("print the installed Mobius CLI version")
        .action(() => {
            process.stdout.write(`${context.version}\n`);
        });
}
