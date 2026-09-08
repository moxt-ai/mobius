import { MOBIUS_API_PREFIX, parseMobiusApiPrefix } from "@moxt-ai/mobius-protocol";
import { createInjector } from "typed-inject";

import type { RelayDependencies } from "./relay-api.ts";
import { MobiusApplication } from "./relay-api.ts";
import { RelayUseCases } from "./relay-use-cases.ts";

export type MobiusApplicationEnvironment = RelayDependencies;

export function createMobiusApplication(
    environment: MobiusApplicationEnvironment,
    apiPrefix: string = MOBIUS_API_PREFIX,
) {
    return createInjector()
        .provideValue("channelRuntime", environment.channelRuntime)
        .provideValue("pairingDirectory", environment.pairingDirectory)
        .provideValue("sessionRuntime", environment.sessionRuntime)
        .provideClass("useCases", RelayUseCases)
        .provideValue("apiPrefix", parseMobiusApiPrefix(apiPrefix))
        .provideClass("application", MobiusApplication);
}
