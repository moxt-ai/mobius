import { createInterface } from "node:readline/promises";

import type { InstallationAuthorizer } from "./agent-installation-manager.ts";
import { readGrantedAgents } from "./installation-grants.ts";

export class ConsoleInstallationAuthorizer implements InstallationAuthorizer {
  readonly #stateDirectory: string;

  constructor(stateDirectory: string) {
    this.#stateDirectory = stateDirectory;
  }

  readonly authorize = async (
    agentId: string,
    label: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const grants = await readGrantedAgents(this.#stateDirectory);
    signal.throwIfAborted();
    if (grants.has(agentId)) {
      return true;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return false;
    }
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await prompt.question(
        `\nMobius Web requested installation of ${label} (${requestId}). Allow this fixed user-level recipe? [y/N] `,
        { signal },
      );
      const normalized = answer.trim().toLowerCase();
      return normalized === "y" || normalized === "yes";
    } finally {
      prompt.close();
    }
  };
}
