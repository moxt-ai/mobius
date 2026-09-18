import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";

import { mobiusApiUrl } from "@moxt-ai/mobius-protocol";
import { fetch, type Response } from "undici";
import { discoverLocalAgentInventory, type LocalAgentInventory } from "../agent-catalog/discover-local-agents.ts";
import type { InstallableAgentDefinition } from "../agent-catalog/local-agent.ts";
import { createDaemonConfig, type DaemonConfig, type LocalAgentDefinition, loadDefaultWorkspace } from "../config.ts";
import { environmentProxyDispatcher } from "../network/environment-proxy.ts";
import { readStateDirectory } from "../storage/state-directory.ts";

const PAIRING_TIMEOUT_MILLISECONDS = 20_000;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){4}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const MAX_CONNECTION_FILE_LENGTH = 16 * 1024;
const CLAIM_RESPONSE_KEYS: readonly string[] = ["channelId", "daemonToken", "runtimeId"];
const REDEEM_RESPONSE_KEYS: readonly string[] = ["channelId", "runtimeCredential", "runtimeId"];
const LEGACY_SAVED_CONNECTION_KEYS: readonly string[] = ["defaultWorkspace", "channelId", "daemonToken", "relayOrigin"];
const SAVED_CONNECTION_KEYS: readonly string[] = ["defaultWorkspace", "channelId", "relayOrigin", "runtimeCredential"];

interface PairCommandOptions {
    readonly code: string;
    readonly pairingId: string;
    readonly relayOrigin: URL;
    readonly workspace: string;
}

interface ClaimPairingResponse {
    readonly channelId: string;
    readonly runtimeCredential: string;
    readonly runtimeId: string;
}

interface SavedConnection {
    readonly defaultWorkspace: string;
    readonly channelId: string;
    readonly relayOrigin: URL;
    readonly runtimeCredential: string;
}

export interface MobiusRuntimePairingOptions {
    readonly defaultWorkspace: string;
    readonly pairingCode: string;
    readonly pairingId: string;
    readonly relayOrigin: string;
}

export interface PairedDaemon {
    readonly channelUrl: string;
    readonly config: DaemonConfig;
    readonly connectionPath: string;
}

export class PairingClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "PairingClientError";
    }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
}

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

function assertKnownArguments(arguments_: readonly string[]): void {
    for (let index = 0; index < arguments_.length; index += 2) {
        const option = arguments_[index];
        if (option !== "--url" && option !== "--code" && option !== "--pairing" && option !== "--workspace") {
            throw new PairingClientError("invalid_arguments", `Unknown pairing option: ${option ?? "missing option"}`);
        }
    }
}

function parseRelayOrigin(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch (error) {
        throw new PairingClientError("invalid_relay_url", "The relay URL is invalid", { cause: error });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new PairingClientError("invalid_relay_url", "The relay URL must use http or https");
    }
    if (url.username.length > 0 || url.password.length > 0) {
        throw new PairingClientError("invalid_relay_url", "The relay URL cannot contain credentials");
    }
    if (url.protocol === "http:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        throw new PairingClientError("invalid_relay_url", "A remote relay must use https");
    }
    url.hash = "";
    url.pathname = "/";
    url.search = "";
    return url;
}

function parsePairingCode(value: string): string {
    const code = value.trim().toUpperCase();
    if (!PAIRING_CODE_PATTERN.test(code)) {
        throw new PairingClientError(
            "invalid_pairing_code",
            "The pairing code must match the code shown in the browser",
        );
    }
    return code;
}

function parsePairCommand(arguments_: readonly string[]): PairCommandOptions {
    assertKnownArguments(arguments_);
    return {
        code: parsePairingCode(readSingleOption(arguments_, "--code")),
        pairingId: arguments_.includes("--pairing") ? validatePairingId(readSingleOption(arguments_, "--pairing")) : "",
        relayOrigin: parseRelayOrigin(readSingleOption(arguments_, "--url")),
        workspace: arguments_.includes("--workspace")
            ? readSingleOption(arguments_, "--workspace")
            : loadDefaultWorkspace(),
    };
}

function validatePairingId(value: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
        throw new PairingClientError("invalid_pairing_id", "The Runtime pairing ID is invalid");
    }
    return value;
}

function parseChannelArgument(arguments_: readonly string[]): string {
    if (arguments_.length !== 2 || arguments_[0] !== "--channel") {
        throw new PairingClientError("invalid_arguments", "Usage: mobius start --channel <channel-id>");
    }
    const channelId = arguments_[1] ?? "";
    if (!IDENTIFIER_PATTERN.test(channelId)) {
        throw new PairingClientError("invalid_channel_id", "The saved channel ID is invalid");
    }
    return channelId;
}

async function resolveDefaultWorkspace(path: string): Promise<string> {
    const requestedWorkspace = resolve(path);
    try {
        await mkdir(requestedWorkspace, { recursive: true, mode: 0o700 });
        const defaultWorkspace = await realpath(requestedWorkspace);
        const metadata = await stat(defaultWorkspace);
        if (!metadata.isDirectory()) {
            throw new PairingClientError("invalid_workspace", "The default workspace is not a directory");
        }
        return defaultWorkspace;
    } catch (error) {
        if (error instanceof PairingClientError) {
            throw error;
        }
        throw new PairingClientError("invalid_workspace", "The default workspace cannot be resolved", { cause: error });
    }
}

async function readJsonResponse(response: Response): Promise<unknown> {
    if (response.headers.get("cf-mitigated") === "challenge") {
        throw new PairingClientError(
            "relay_challenge",
            "Cloudflare is protecting this temporary preview. Claim the deployment or use an authenticated deployment, then pair again",
        );
    }
    const encoded = await response.text();
    try {
        return JSON.parse(encoded);
    } catch (error) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid response", {
            cause: error,
        });
    }
}

function readRelayError(value: unknown): PairingClientError {
    if (isRecord(value)) {
        const error = value["error"];
        if (isRecord(error)) {
            const code = error["code"];
            const message = error["message"];
            if (typeof code === "string" && typeof message === "string") {
                return new PairingClientError(code, message);
            }
        }
    }
    return new PairingClientError("pairing_failed", "The relay could not pair this machine");
}

function decodePairingResponse(
    value: unknown,
    credentialField: string,
    expectedKeys: readonly string[],
): ClaimPairingResponse {
    if (!isRecord(value) || !hasExactKeys(value, expectedKeys)) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    const channelId = value["channelId"];
    const runtimeCredential = value[credentialField];
    const runtimeId = value["runtimeId"];
    if (
        typeof channelId !== "string" ||
        !IDENTIFIER_PATTERN.test(channelId) ||
        typeof runtimeCredential !== "string" ||
        !TOKEN_PATTERN.test(runtimeCredential) ||
        typeof runtimeId !== "string" ||
        !IDENTIFIER_PATTERN.test(runtimeId)
    ) {
        throw new PairingClientError("invalid_relay_response", "The relay returned an invalid pairing response");
    }
    return { channelId, runtimeCredential, runtimeId };
}

async function claimPairing(
    options: PairCommandOptions,
    defaultWorkspace: string,
    localAgents: readonly LocalAgentDefinition[],
    installableAgents: readonly InstallableAgentDefinition[],
    signal: AbortSignal,
): Promise<ClaimPairingResponse> {
    const agents = localAgents.map((agent) => ({
        agentPath: agent.agentIdentity.requestedPath,
        agentVersion: agent.agentVersion,
        agentSettingsDiscovery: true,
        capabilities: agent.capabilities,
        id: agent.id,
        label: agent.label,
        sessionTurnConfiguration: true,
    }));
    const endpoint =
        options.pairingId.length > 0
            ? mobiusApiUrl(options.relayOrigin, `/v1/runtime-pairings/${encodeURIComponent(options.pairingId)}/redeem`)
            : mobiusApiUrl(options.relayOrigin, "/pairings/claim");
    let response: Response;
    try {
        response = await fetch(endpoint, {
            body: JSON.stringify({
                agents,
                installableAgents,
                machineName: hostname(),
                pairingCode: options.code,
                workspaceName: basename(defaultWorkspace) || "Local workspace",
            }),
            dispatcher: environmentProxyDispatcher,
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.any([signal, AbortSignal.timeout(PAIRING_TIMEOUT_MILLISECONDS)]),
        });
    } catch (error) {
        throw new PairingClientError("relay_unavailable", "The pairing relay could not be reached", { cause: error });
    }

    const value = await readJsonResponse(response);
    if (!response.ok) {
        throw readRelayError(value);
    }
    return options.pairingId.length > 0
        ? decodePairingResponse(value, "runtimeCredential", REDEEM_RESPONSE_KEYS)
        : decodePairingResponse(value, "daemonToken", CLAIM_RESPONSE_KEYS);
}

async function persistConnection(
    channelId: string,
    relayOrigin: URL,
    runtimeCredential: string,
    defaultWorkspace: string,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
    const connectionsDirectory = join(readStateDirectory(environment), "connections");
    await mkdir(connectionsDirectory, { mode: 0o700, recursive: true });
    const connectionPath = join(connectionsDirectory, `${channelId}.json`);
    const temporaryPath = join(connectionsDirectory, `.${channelId}.${randomUUID()}.tmp`);
    await writeFile(
        temporaryPath,
        `${JSON.stringify(
            {
                defaultWorkspace,
                channelId,
                relayOrigin: relayOrigin.toString(),
                runtimeCredential,
            },
            null,
            2,
        )}\n`,
        { flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, connectionPath);
    return connectionPath;
}

function decodeSavedConnection(value: unknown, expectedChannelId: string): SavedConnection {
    if (
        !isRecord(value) ||
        (!hasExactKeys(value, SAVED_CONNECTION_KEYS) && !hasExactKeys(value, LEGACY_SAVED_CONNECTION_KEYS))
    ) {
        throw new PairingClientError("invalid_connection", "The saved connection is invalid");
    }
    const defaultWorkspace = value["defaultWorkspace"];
    const channelId = value["channelId"];
    const runtimeCredential = value["runtimeCredential"] ?? value["daemonToken"];
    const relayOrigin = value["relayOrigin"];
    if (
        typeof defaultWorkspace !== "string" ||
        typeof channelId !== "string" ||
        channelId !== expectedChannelId ||
        !IDENTIFIER_PATTERN.test(channelId) ||
        typeof runtimeCredential !== "string" ||
        !TOKEN_PATTERN.test(runtimeCredential) ||
        typeof relayOrigin !== "string"
    ) {
        throw new PairingClientError("invalid_connection", "The saved connection is invalid");
    }
    return {
        defaultWorkspace,
        channelId,
        relayOrigin: parseRelayOrigin(relayOrigin),
        runtimeCredential,
    };
}

async function readSavedConnection(
    channelId: string,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<SavedConnection> {
    const connectionPath = join(readStateDirectory(environment), "connections", `${channelId}.json`);
    let encoded = "";
    const handle = await open(connectionPath, "r");
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_CONNECTION_FILE_LENGTH) {
            throw new PairingClientError("invalid_connection", "The saved connection is invalid");
        }
        encoded = await handle.readFile({ encoding: "utf8" });
    } finally {
        await handle.close();
    }

    let value: unknown;
    try {
        value = JSON.parse(encoded);
    } catch (error) {
        throw new PairingClientError("invalid_connection", "The saved connection is invalid", { cause: error });
    }
    const connection = decodeSavedConnection(value, channelId);
    return {
        defaultWorkspace: await resolveDefaultWorkspace(connection.defaultWorkspace),
        channelId: connection.channelId,
        relayOrigin: connection.relayOrigin,
        runtimeCredential: connection.runtimeCredential,
    };
}

function assertInventoryUsable(inventory: LocalAgentInventory): void {
    if (inventory.available.length + inventory.installable.length === 0) {
        throw new PairingClientError("no_supported_agent", "No supported Agent is available for local discovery");
    }
}

function buildPairedDaemon(
    connection: SavedConnection,
    connectionPath: string,
    inventory: LocalAgentInventory,
    environment: Readonly<NodeJS.ProcessEnv>,
): PairedDaemon {
    assertInventoryUsable(inventory);
    const relayUrl = mobiusApiUrl(connection.relayOrigin, "/v1/runtimes/connect");
    relayUrl.protocol = relayUrl.protocol === "https:" ? "wss:" : "ws:";
    relayUrl.searchParams.set("token", connection.runtimeCredential);
    const auditDatabasePath = join(readStateDirectory(environment), "audit", `${connection.channelId}.sqlite`);

    return {
        channelUrl: new URL(`/channels/${encodeURIComponent(connection.channelId)}`, connection.relayOrigin).toString(),
        config: createDaemonConfig(
            {
                defaultWorkspace: connection.defaultWorkspace,
                auditDatabasePath,
                channelId: connection.channelId,
                relayUrl,
            },
            inventory.readyAgents(),
            inventory.installable,
        ),
        connectionPath,
    };
}

async function pairRuntime(
    options: PairCommandOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<PairedDaemon> {
    const defaultWorkspace = await resolveDefaultWorkspace(options.workspace);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace,
        environment,
        signal,
    });
    assertInventoryUsable(inventory);
    const agents = inventory.readyAgents();
    const claim = await claimPairing(options, defaultWorkspace, agents, inventory.installable, signal);
    const connectionPath = await persistConnection(
        claim.channelId,
        options.relayOrigin,
        claim.runtimeCredential,
        defaultWorkspace,
        environment,
    );
    return buildPairedDaemon(
        {
            defaultWorkspace,
            channelId: claim.channelId,
            relayOrigin: options.relayOrigin,
            runtimeCredential: claim.runtimeCredential,
        },
        connectionPath,
        inventory,
        environment,
    );
}

export async function pairMobiusRuntime(
    options: MobiusRuntimePairingOptions,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<PairedDaemon> {
    return await pairRuntime(
        {
            code: parsePairingCode(options.pairingCode),
            pairingId: validatePairingId(options.pairingId),
            relayOrigin: parseRelayOrigin(options.relayOrigin),
            workspace: options.defaultWorkspace,
        },
        signal,
        environment,
    );
}

export async function pairLocalMachine(
    arguments_: readonly string[],
    signal: AbortSignal = new AbortController().signal,
): Promise<PairedDaemon> {
    return await pairRuntime(parsePairCommand(arguments_), signal, process.env);
}

export async function resumeMobiusRuntime(
    channelId: string,
    signal: AbortSignal,
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<PairedDaemon> {
    const normalizedChannelId = validatePairingId(channelId);
    const connectionPath = join(readStateDirectory(environment), "connections", `${normalizedChannelId}.json`);
    const connection = await readSavedConnection(normalizedChannelId, environment);
    const inventory = await discoverLocalAgentInventory({
        defaultWorkspace: connection.defaultWorkspace,
        environment,
        signal,
    });
    return buildPairedDaemon(connection, connectionPath, inventory, environment);
}

export async function resumeLocalMachine(
    arguments_: readonly string[],
    signal: AbortSignal = new AbortController().signal,
): Promise<PairedDaemon> {
    return await resumeMobiusRuntime(parseChannelArgument(arguments_), signal, process.env);
}
