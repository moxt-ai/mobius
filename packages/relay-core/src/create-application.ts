import { createInjector } from "typed-inject";

import type { RelayDependencies } from "./relay-api.ts";
import { MobiusApplication } from "./relay-api.ts";

export type MobiusApplicationEnvironment = RelayDependencies;

export function createMobiusApplication(
  environment: MobiusApplicationEnvironment,
) {
  return createInjector()
    .provideValue("channelRuntime", environment.channelRuntime)
    .provideValue("pairingDirectory", environment.pairingDirectory)
    .provideValue("sessionRuntime", environment.sessionRuntime)
    .provideClass("application", MobiusApplication);
}
