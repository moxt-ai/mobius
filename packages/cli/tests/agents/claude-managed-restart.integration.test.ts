import { registerManagedCrashScenarios, registerManagedRestartScenarios } from "../support/managed-restart.ts";

registerManagedRestartScenarios("claude");
registerManagedCrashScenarios("claude");
