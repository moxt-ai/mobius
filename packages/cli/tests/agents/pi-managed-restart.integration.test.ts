import { registerManagedCrashScenarios, registerManagedRestartScenarios } from "../support/managed-restart.ts";

registerManagedRestartScenarios("pi");
registerManagedCrashScenarios("pi");
