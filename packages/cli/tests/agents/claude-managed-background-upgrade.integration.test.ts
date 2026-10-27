import { registerManagedUpgradeScenarios } from "../support/managed-upgrade.ts";

registerManagedUpgradeScenarios([
    { agentId: "claude", mode: "background", exitCode: 0, taskCount: 1 },
    { agentId: "claude", mode: "background", exitCode: 1, taskCount: 1 },
]);
