import { registerManagedUpgradeScenarios } from "../support/managed-upgrade.ts";

registerManagedUpgradeScenarios([{ agentId: "pi", mode: "foreground", exitCode: 0, taskCount: 1 }]);
