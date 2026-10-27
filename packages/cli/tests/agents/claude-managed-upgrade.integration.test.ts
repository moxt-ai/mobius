import { registerManagedUpgradeScenarios } from "../support/managed-upgrade.ts";

registerManagedUpgradeScenarios([
    { agentId: "claude", mode: "background", exitCode: 0, taskCount: 2 },
    { agentId: "claude", mode: "foreground", exitCode: 0, taskCount: 1 },
]);
