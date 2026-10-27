import { registerManagedCrashScenarios, registerManagedRestartScenarios } from "../support/managed-restart.ts";

registerManagedRestartScenarios("codex");
registerManagedCrashScenarios("codex");
