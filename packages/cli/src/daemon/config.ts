import { join } from "node:path";
import { isIdentifier } from "@moxt-ai/mobius-sdk/protocol";
import { MobiusRuntimeConfigurationError, type MobiusRuntimeConnection } from "../engine/runtime/engine.ts";
import { readStateDirectory } from "../storage/state-directory.ts";

export function resolveMaxAcpProcesses(environment: Readonly<NodeJS.ProcessEnv>): number {
    const configured = environment["MOBIUS_MAX_ACP_PROCESSES"];
    if (configured === undefined || configured === "") {
        return 1000;
    }
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("MOBIUS_MAX_ACP_PROCESSES must be a positive integer");
    }
    return parsed;
}

export function mobiusEngineDataDir(version: string, environment: Readonly<NodeJS.ProcessEnv>): string {
    return join(readStateDirectory(environment), "versions", version, "installations", "dev.mobius.cli");
}

function requiredEnvironmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string): string {
    const value = environment[name]?.trim();
    if (value === undefined || value.length === 0) {
        throw new MobiusRuntimeConfigurationError(`${name} is required`);
    }
    return value;
}

export function loadMobiusRuntimeConnection(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): MobiusRuntimeConnection {
    const channelId = requiredEnvironmentValue(environment, "MOBIUS_CHANNEL_ID");
    if (!isIdentifier(channelId)) {
        throw new MobiusRuntimeConfigurationError("MOBIUS_CHANNEL_ID is invalid");
    }
    return Object.freeze({
        channelId,
        defaultWorkspace: join(readStateDirectory(environment), "workspace"),
        relayUrl: requiredEnvironmentValue(environment, "MOBIUS_RELAY_URL"),
        runtimeCredential: requiredEnvironmentValue(environment, "MOBIUS_RELAY_TOKEN"),
    });
}
