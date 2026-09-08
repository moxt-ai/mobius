import { MOBIUS_API_PREFIX } from "@moxt-ai/mobius-protocol";
import type { Hono } from "hono";

import { createMobiusApplication, type MobiusApplicationEnvironment } from "./create-application.ts";

export type RelayDependencies = MobiusApplicationEnvironment;

export function createRelayApp(dependencies: RelayDependencies, apiPrefix: string = MOBIUS_API_PREFIX): Hono {
    return createMobiusApplication(dependencies, apiPrefix).create().resolve("application");
}
