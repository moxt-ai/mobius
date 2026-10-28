import { registerManagedUpgradeScenarios } from "../support/managed-upgrade.ts";

registerManagedUpgradeScenarios([{ agentId: "claude", mode: "long-foreground", exitCode: 0, taskCount: 1 }]);
