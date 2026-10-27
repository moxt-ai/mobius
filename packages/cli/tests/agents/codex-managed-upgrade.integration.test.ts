import { registerManagedUpgradeScenarios } from "../support/managed-upgrade.ts";

registerManagedUpgradeScenarios([
    { agentId: "codex", mode: "background", exitCode: 0, taskCount: 1 },
    { agentId: "codex", mode: "background", exitCode: 1, taskCount: 1 },
    { agentId: "codex", mode: "endpoint-exit", exitCode: 0, taskCount: 1 },
]);
