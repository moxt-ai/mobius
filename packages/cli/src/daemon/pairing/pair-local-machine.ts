import { join } from "node:path";
import packageMetadata from "../../../package.json" with { type: "json" };
import type { VerifiedRuntimeConnection } from "../../engine/runtime/connection/runtime-connection.ts";
import {
    RuntimeInstallationStore,
    RuntimeInstallationStoreError,
} from "../../engine/runtime/connection/runtime-installation-store.ts";
import { MobiusRuntimeEngine } from "../../engine/runtime/engine.ts";
import {
    PairingClientError,
    parsePairingCode,
    parseRelayOrigin,
    prepareRuntimeConnection,
    validatePairingId,
} from "../../engine/runtime/pairing.ts";
import { ensurePrivateDirectory } from "../../engine/storage/files/local-files.ts";
import { validateLocalPath } from "../../engine/util/filesystem/private-path.ts";
import { readCurrentDataVersion } from "../../storage/daemon/version-data.ts";
import { readStateDirectory } from "../../storage/state-directory.ts";
import { prepareMobiusEngineDataDir, resolveMaxAcpProcesses } from "../config.ts";

export { PairingClientError };

function readSingleOption(arguments_: readonly string[], option: string): string {
    const values: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        if (arguments_[index] !== option) {
            continue;
        }
        const value = arguments_[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new PairingClientError("invalid_arguments", `${option} requires a value`);
        }
        values.push(value);
        index += 1;
    }
    if (values.length !== 1) {
        throw new PairingClientError("invalid_arguments", `${option} must be provided exactly once`);
    }
    return values[0] ?? "";
}

function parsePairCommand(arguments_: readonly string[], defaultWorkspace: string) {
    for (let index = 0; index < arguments_.length; index += 2) {
        const option = arguments_[index];
        if (option !== "--url" && option !== "--code" && option !== "--pairing" && option !== "--workspace") {
            throw new PairingClientError("invalid_arguments", `Unknown pairing option: ${option ?? "missing option"}`);
        }
    }
    return {
        code: parsePairingCode(readSingleOption(arguments_, "--code")),
        pairingId: arguments_.includes("--pairing") ? validatePairingId(readSingleOption(arguments_, "--pairing")) : "",
        relayOrigin: parseRelayOrigin(readSingleOption(arguments_, "--url")),
        workspace: arguments_.includes("--workspace") ? readSingleOption(arguments_, "--workspace") : defaultWorkspace,
    };
}

export async function openMobiusControlInstallation(
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeInstallationStore> {
    const root = readStateDirectory(environment);
    try {
        await ensurePrivateDirectory(root);
        await validateLocalPath(root, true, true, signal);
    } catch (cause) {
        signal.throwIfAborted();
        throw new RuntimeInstallationStoreError(
            "installation_unavailable",
            "The local installation cannot be initialized",
            { cause },
        );
    }
    return await RuntimeInstallationStore.open(join(root, "installations", "dev.mobius.cli"), signal);
}

// Commands follow the daemon's current data; before first startup they use this CLI version.
export async function openMobiusCliInstallation(
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeInstallationStore> {
    const root = readStateDirectory(environment);
    const version = (await readCurrentDataVersion(root, signal)) ?? packageMetadata.version;
    return await openMobiusVersionInstallation(version, signal, environment);
}

export async function openMobiusVersionInstallation(
    version: string,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<RuntimeInstallationStore> {
    return await RuntimeInstallationStore.open(await prepareMobiusEngineDataDir(version, signal, environment), signal);
}

export async function pairLocalMachine(
    arguments_: readonly string[],
    signal: AbortSignal = new AbortController().signal,
): Promise<VerifiedRuntimeConnection> {
    const requested = parsePairCommand(arguments_, "");
    const version = (await readCurrentDataVersion(readStateDirectory(process.env), signal)) ?? packageMetadata.version;
    const engineDataDir = await prepareMobiusEngineDataDir(version, signal, process.env);
    const engine = new MobiusRuntimeEngine({ engineDataDir, agentLaunchEnvironment: process.env });
    const installation = await openMobiusVersionInstallation(version, signal, process.env);
    if (requested.pairingId.length > 0) {
        const existing = await installation.readConnectionForPairing(requested.pairingId, signal);
        if (existing !== null) {
            await prepareRuntimeConnection(
                installation,
                existing,
                signal,
                process.env,
                resolveMaxAcpProcesses(process.env),
            );
            return existing;
        }
    }
    return await engine.pair(
        {
            pairingCode: requested.code,
            pairingId: requested.pairingId,
            relayOrigin: requested.relayOrigin.toString(),
            defaultWorkspace: arguments_.includes("--workspace")
                ? requested.workspace
                : join(installation.stateDirectory, "workspace"),
        },
        signal,
    );
}
