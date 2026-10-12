#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PORT_SPECS = [
    { base: 8787, name: "MOBIUS_RELAY_PORT" },
    { base: 5190, name: "MOBIUS_WEB_PORT" },
];

const MAX_TCP_PORT = 65_535;
const LEGACY_PREFERRED_OFFSET_COUNT = 100;
const MANAGED_OFFSET_COUNT =
    Math.min(...PORT_SPECS.map(({ base, offsetStep = 1 }) => Math.floor((MAX_TCP_PORT - base) / offsetStep))) + 1;
const LOCK_NAME = "mobius-worktree-ports.lock";
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 5 * 60_000;
const PROCESS_STOP_WAIT_MS = 1_000;
const PROCESS_STOP_POLL_MS = 50;
const PORT_NAMES = new Set(PORT_SPECS.map(({ name }) => name));

function delay(milliseconds) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function parsePortValue(rawValue) {
    const match = rawValue.trim().match(/^(['"]?)(\d+)\1$/);
    if (!match) {
        return undefined;
    }
    const value = Number(match[2]);
    return Number.isSafeInteger(value) ? value : undefined;
}

function isPortInManagedRange(name, value) {
    const spec = PORT_SPECS.find((candidate) => candidate.name === name);
    if (!spec) {
        return false;
    }
    const offsetStep = spec.offsetStep ?? 1;
    const delta = value - spec.base;
    return delta >= 0 && delta % offsetStep === 0 && delta / offsetStep < MANAGED_OFFSET_COUNT;
}

function isTcpPort(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

export function parsePortConfiguration(content) {
    const valuesByName = Object.fromEntries(PORT_SPECS.map(({ name }) => [name, []]));

    for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=(.*)$/);
        if (!match || !PORT_NAMES.has(match[1])) {
            continue;
        }
        const value = parsePortValue(match[2]);
        valuesByName[match[1]].push(value);
    }

    const presentCount = Object.values(valuesByName).reduce((total, values) => total + values.length, 0);
    const ports = {};
    const isValid = PORT_SPECS.every(({ name }) => {
        const values = valuesByName[name];
        if (values.length !== 1 || !isPortInManagedRange(name, values[0])) {
            return false;
        }
        ports[name] = values[0];
        return true;
    });

    return {
        claimedEntries: PORT_SPECS.flatMap(({ name }) =>
            valuesByName[name].filter(isTcpPort).map((port) => ({ name, port })),
        ),
        ports: isValid ? ports : undefined,
        status: isValid ? "valid" : presentCount === 0 ? "missing" : "invalid",
    };
}

function renderPortConfiguration(content, ports) {
    const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let insertionIndex = lines.findIndex((line) => {
        const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=/);
        return match && PORT_NAMES.has(match[1]);
    });
    if (insertionIndex === -1) {
        insertionIndex = lines.length;
    }

    const retainedLines = lines.filter((line) => {
        const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=/);
        return !match || !PORT_NAMES.has(match[1]);
    });
    const removedBeforeInsertion = lines.slice(0, insertionIndex).filter((line) => {
        const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=/);
        return match && PORT_NAMES.has(match[1]);
    }).length;
    const retainedInsertionIndex = insertionIndex - removedBeforeInsertion;
    const portLines = PORT_SPECS.map(({ name }) => `${name}=${ports[name]}\n`);

    if (retainedLines.length === 0) {
        return ["# Worktree port configuration managed by scripts/worktree/port-allocator.mjs\n", ...portLines].join(
            "",
        );
    }

    if (
        retainedInsertionIndex === retainedLines.length &&
        retainedLines.length > 0 &&
        !retainedLines.at(-1).endsWith("\n")
    ) {
        retainedLines[retainedLines.length - 1] += "\n";
    }
    retainedLines.splice(retainedInsertionIndex, 0, ...portLines);
    return retainedLines.join("");
}

export async function atomicWriteEnvironment(path, content, overrides = {}) {
    const temporaryPath = join(dirname(path), `.${randomUUID()}.env.worktree.tmp`);
    const renameFile = overrides.rename ?? rename;
    let handle;

    try {
        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await renameFile(temporaryPath, path);
        await chmod(path, 0o600);

        const directoryHandle = await open(dirname(path), "r");
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } catch (error) {
        if (handle) {
            await handle.close().catch(() => {});
        }
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
    }
}

function getGitOutput(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function getGitCommonDirectory(cwd) {
    const commonDirectory = getGitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return isAbsolute(commonDirectory) ? commonDirectory : resolve(cwd, commonDirectory);
}

function listWorktrees(cwd) {
    return getGitOutput(cwd, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length));
}

async function readEnvironment(path) {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== "ESRCH";
    }
}

async function isLockStale(lockDirectory) {
    let owner;
    try {
        owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
    } catch {
        const lockStat = await stat(lockDirectory);
        return Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
    }

    if (
        typeof owner.hostname !== "string" ||
        !Number.isSafeInteger(owner.pid) ||
        !Number.isFinite(owner.createdAt) ||
        typeof owner.token !== "string"
    ) {
        const lockStat = await stat(lockDirectory);
        return Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
    }
    if (owner.hostname === hostname() && Number.isSafeInteger(owner.pid)) {
        return !isProcessAlive(owner.pid);
    }
    return Date.now() - owner.createdAt > LOCK_STALE_MS;
}

async function reclaimStaleLock(lockDirectory, token) {
    const staleDirectory = `${lockDirectory}.stale-${token}`;
    try {
        await rename(lockDirectory, staleDirectory);
    } catch (error) {
        if (error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    await rm(staleDirectory, { recursive: true });
}

async function acquireLock(commonDirectory) {
    const lockDirectory = join(commonDirectory, LOCK_NAME);
    const token = randomUUID();
    const startedAt = Date.now();

    while (true) {
        try {
            await mkdir(lockDirectory, { mode: 0o700 });
            await atomicWriteEnvironment(
                join(lockDirectory, "owner.json"),
                `${JSON.stringify({
                    createdAt: Date.now(),
                    hostname: hostname(),
                    pid: process.pid,
                    token,
                })}\n`,
            );
            return { lockDirectory, token };
        } catch (error) {
            if (error.code !== "EEXIST") {
                await rm(lockDirectory, { force: true, recursive: true }).catch(() => {});
                throw error;
            }
        }

        if (await isLockStale(lockDirectory)) {
            await reclaimStaleLock(lockDirectory, token);
            continue;
        }
        if (Date.now() - startedAt >= LOCK_WAIT_MS) {
            throw new Error(
                `Timed out waiting for the worktree port lock at ${lockDirectory}. ` +
                    "If no setup process is running, remove the stale lock and retry.",
            );
        }
        await delay(50);
    }
}

async function releaseLock({ lockDirectory, token }) {
    let owner;
    try {
        owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
    } catch {
        return;
    }
    if (owner.token !== token) {
        return;
    }
    await unlink(join(lockDirectory, "owner.json"));
    await rmdir(lockDirectory);
}

async function withAllocationLock(cwd, callback) {
    const lock = await acquireLock(getGitCommonDirectory(cwd));
    try {
        return await callback();
    } finally {
        await releaseLock(lock);
    }
}

async function scanPersistedClaims(cwd, currentWorktree) {
    const claims = new Map();
    for (const worktree of listWorktrees(cwd)) {
        if (resolve(worktree) === currentWorktree) {
            continue;
        }
        const parsed = parsePortConfiguration(await readEnvironment(join(worktree, ".env.worktree")));
        for (const { port } of parsed.claimedEntries) {
            const owners = claims.get(port) ?? [];
            owners.push(worktree);
            claims.set(port, owners);
        }
    }
    return claims;
}

function preferredOffsetForWorktree(worktree) {
    const hash = createHash("sha256").update(worktree).digest();
    return hash.readUInt32BE(0) % Math.min(LEGACY_PREFERRED_OFFSET_COUNT, MANAGED_OFFSET_COUNT);
}

function bundleForOffset(offset) {
    return Object.fromEntries(PORT_SPECS.map(({ base, name, offsetStep = 1 }) => [name, base + offset * offsetStep]));
}

function* allocationOffsets(preferredOffset) {
    const preferredOffsetCount = Math.min(LEGACY_PREFERRED_OFFSET_COUNT, MANAGED_OFFSET_COUNT);
    if (preferredOffset < preferredOffsetCount) {
        for (let attempt = 0; attempt < preferredOffsetCount; attempt += 1) {
            yield (preferredOffset + attempt) % preferredOffsetCount;
        }
        for (let offset = preferredOffsetCount; offset < MANAGED_OFFSET_COUNT; offset += 1) {
            yield offset;
        }
        return;
    }

    for (let attempt = 0; attempt < MANAGED_OFFSET_COUNT; attempt += 1) {
        yield (preferredOffset + attempt) % MANAGED_OFFSET_COUNT;
    }
}

function closeServer(server) {
    return new Promise((resolveClose) => server.close(resolveClose));
}

async function reservePorts(ports) {
    const servers = [];
    for (const { name } of PORT_SPECS.filter(({ name }) => ports[name] !== undefined)) {
        if (listenerPids(ports[name]).length > 0) {
            await Promise.all(servers.map(closeServer));
            return {
                occupied: { name, port: ports[name] },
                servers: [],
            };
        }
        const server = createServer();
        try {
            await new Promise((resolveListen, rejectListen) => {
                server.once("error", rejectListen);
                server.listen({ exclusive: true, port: ports[name] }, resolveListen);
            });
            servers.push(server);
        } catch (error) {
            await Promise.all(servers.map(closeServer));
            if (error.code === "EADDRINUSE" || error.code === "EACCES") {
                return { occupied: { name, port: ports[name] }, servers: [] };
            }
            throw error;
        }
    }
    return { occupied: undefined, servers };
}

async function releaseReservations(reservations) {
    await Promise.all(reservations.servers.map(closeServer));
}

function portOwners(ports, claims) {
    return PORT_SPECS.flatMap(({ name }) =>
        (claims.get(ports[name]) ?? []).map((worktree) => ({
            name,
            port: ports[name],
            worktree,
        })),
    );
}

function listenerDiagnostics(port) {
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpct"], {
        encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
        return "PID(s): unknown";
    }

    const processes = [];
    let current = {};
    for (const line of result.stdout.split(/\r?\n/)) {
        if (line.startsWith("p")) {
            if (current.pid) {
                processes.push(current);
            }
            current = { pid: line.slice(1) };
        } else if (line.startsWith("c")) {
            current.command = line.slice(1);
        }
    }
    if (current.pid) {
        processes.push(current);
    }
    return processes.length === 0
        ? "PID(s): unknown"
        : `PID(s): ${processes.map(({ command, pid }) => `${pid}${command ? ` (${command})` : ""}`).join(", ")}`;
}

export function listenerPids(port, environment = process.env) {
    const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
        encoding: "utf8",
        env: environment,
    });
    if (result.error) {
        if (result.error.code === "ENOENT") {
            const socketResult = spawnSync("ss", ["-H", "-ltnp", `sport = :${port}`], {
                encoding: "utf8",
                env: environment,
            });
            if (socketResult.error) {
                throw new Error(`Failed to inspect listener(s) for port ${port}: neither lsof nor ss is available`);
            }
            if (socketResult.status !== 0) {
                throw new Error(
                    `Failed to inspect listener(s) for port ${port}: ${socketResult.stderr.trim() || `ss exited with status ${socketResult.status}`}`,
                );
            }
            return [...socketResult.stdout.matchAll(/\bpid=([0-9]+)\b/g)]
                .map((match) => Number(match[1]))
                .filter(Number.isSafeInteger);
        }
        throw new Error(`Failed to inspect listener(s) for port ${port}: ${result.error.message}`);
    }
    if (result.status === 1 && result.stdout.trim() === "") {
        return [];
    }
    if (result.status !== 0) {
        throw new Error(
            `Failed to inspect listener(s) for port ${port}: ${result.stderr.trim() || `lsof exited with status ${result.status}`}`,
        );
    }
    return result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("p"))
        .map((line) => Number(line.slice(1)))
        .filter(Number.isSafeInteger);
}

function claimedPortListeners(claimedEntries) {
    const listenersByPid = new Map();
    for (const { name, port } of claimedEntries) {
        for (const pid of listenerPids(port)) {
            const listener = listenersByPid.get(pid) ?? { pid, ports: [] };
            listener.ports.push({ name, port });
            listenersByPid.set(pid, listener);
        }
    }
    return [...listenersByPid.values()];
}

function processRelationships() {
    const result = spawnSync("ps", ["-e", "-o", "pid=", "-o", "ppid="], {
        encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Failed to inspect the process tree: ${result.error?.message ?? result.stderr.trim()}`);
    }
    const parents = new Map();
    const children = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) {
            continue;
        }
        const pid = Number(match[1]);
        const parentPid = Number(match[2]);
        parents.set(pid, parentPid);
        const childPids = children.get(parentPid) ?? [];
        childPids.push(pid);
        children.set(parentPid, childPids);
    }
    return { children, parents };
}

function currentProcessAncestry(parents) {
    const ancestry = new Set([process.pid]);
    let pid = process.pid;
    while (parents.has(pid)) {
        pid = parents.get(pid);
        if (pid <= 1 || ancestry.has(pid)) {
            break;
        }
        ancestry.add(pid);
    }
    return ancestry;
}

function processTreePids(rootPid, children) {
    const pids = [];
    const pending = [rootPid];
    while (pending.length > 0) {
        const pid = pending.pop();
        if (pids.includes(pid)) {
            continue;
        }
        pids.push(pid);
        pending.push(...(children.get(pid) ?? []));
    }
    return pids.reverse();
}

function signalListeners(listeners, signal) {
    const { children, parents } = processRelationships();
    const protectedPids = currentProcessAncestry(parents);
    const targets = new Set();

    for (const { pid } of listeners) {
        if (protectedPids.has(pid)) {
            throw new Error(`Refusing to signal PID ${pid} because it belongs to the current delete command ancestry`);
        }
        for (const targetPid of processTreePids(pid, children)) {
            if (protectedPids.has(targetPid)) {
                throw new Error(
                    `Refusing to signal PID ${targetPid} because it belongs to the current delete command ancestry`,
                );
            }
            targets.add(targetPid);
        }
    }

    for (const pid of targets) {
        try {
            process.kill(pid, signal);
        } catch (error) {
            if (error.code !== "ESRCH") {
                throw new Error(`Failed to send ${signal} to PID ${pid}: ${error.message}`);
            }
        }
    }
}

function formatListenerPorts(ports) {
    return ports.map(({ name, port }) => `${name}=${port}`).join(", ");
}

async function waitForClaimedPortListeners(claimedEntries) {
    const deadline = Date.now() + PROCESS_STOP_WAIT_MS;
    let listeners = claimedPortListeners(claimedEntries);
    while (listeners.length > 0 && Date.now() < deadline) {
        await delay(PROCESS_STOP_POLL_MS);
        listeners = claimedPortListeners(claimedEntries);
    }
    return listeners;
}

function occupiedPortError({ name, port }, command) {
    return new Error(
        `${name}=${port} is already listening. ` +
            `Run \`kill $(lsof -nP -tiTCP:${port} -sTCP:LISTEN)\` to free the port, ` +
            `or run \`${command}\` to allocate a different bundle.`,
    );
}

async function findOccupiedClaim(claimedEntries) {
    for (const { name, port } of claimedEntries) {
        const reservation = await reservePorts({ [name]: port });
        if (reservation.occupied) {
            return reservation.occupied;
        }
        await releaseReservations(reservation);
    }
    return undefined;
}

async function assertNoUnidentifiedListener(claimedEntries) {
    const occupied = await findOccupiedClaim(claimedEntries);
    if (occupied) {
        throw new Error(
            `${occupied.name}=${occupied.port} is still listening, but its PID could not be identified; refusing to delete the worktree`,
        );
    }
}

async function allocateBundle({ claims, content, envPath, preferredOffset }) {
    for (const offset of allocationOffsets(preferredOffset)) {
        const ports = bundleForOffset(offset);
        if (portOwners(ports, claims).length > 0) {
            continue;
        }

        const reservations = await reservePorts(ports);
        if (reservations.occupied) {
            continue;
        }
        try {
            await atomicWriteEnvironment(envPath, renderPortConfiguration(content, ports));
            return ports;
        } finally {
            await releaseReservations(reservations);
        }
    }
    throw new Error(
        `No worktree port bundle is available in the ${MANAGED_OFFSET_COUNT} managed offsets. ` +
            "Stop unused local services or remove obsolete worktrees, then retry.",
    );
}

export async function runPortAllocation({ cwd, mode, preferredOffset }) {
    if (!["ensure", "preflight", "repair"].includes(mode)) {
        throw new Error(`Unsupported allocation mode: ${mode}`);
    }
    const currentWorktree = resolve(getGitOutput(cwd, ["rev-parse", "--show-toplevel"]));
    const envPath = join(currentWorktree, ".env.worktree");

    return withAllocationLock(cwd, async () => {
        const content = await readEnvironment(envPath);
        const parsed = parsePortConfiguration(content);
        const claims = await scanPersistedClaims(cwd, currentWorktree);

        if (parsed.status === "valid" && portOwners(parsed.ports, claims).length === 0) {
            const reservations = await reservePorts(parsed.ports);
            if (!reservations.occupied) {
                await releaseReservations(reservations);
                await chmod(envPath, 0o600);
                return { action: "preserved", ports: parsed.ports };
            }
            if (mode !== "repair") {
                throw occupiedPortError(reservations.occupied, "scripts/worktree/port-allocator.mjs repair");
            }
        }

        if (mode !== "repair") {
            const occupied = await findOccupiedClaim(parsed.claimedEntries);
            if (occupied) {
                throw occupiedPortError(occupied, "scripts/worktree/port-allocator.mjs repair");
            }
        }

        const offset = preferredOffset ?? preferredOffsetForWorktree(currentWorktree);
        if (!Number.isInteger(offset) || offset < 0 || offset >= MANAGED_OFFSET_COUNT) {
            throw new Error(`Preferred port offset must be an integer from 0 to ${MANAGED_OFFSET_COUNT - 1}`);
        }
        const ports = await allocateBundle({
            claims,
            content,
            envPath,
            preferredOffset: offset,
        });
        return { action: "allocated", ports };
    });
}

async function assertClaimedPortsStopped(cwd) {
    const currentWorktree = resolve(getGitOutput(cwd, ["rev-parse", "--show-toplevel"]));
    const content = await readEnvironment(join(currentWorktree, ".env.worktree"));
    const parsed = parsePortConfiguration(content);

    for (const { name, port } of parsed.claimedEntries) {
        const reservation = await reservePorts({ [name]: port });
        if (reservation.occupied) {
            throw new Error(
                `${name}=${port} is still listening (${listenerDiagnostics(port)}). ` +
                    "Stop the worktree services before resetting.",
            );
        }
        await releaseReservations(reservation);
    }
}

export async function assertWorktreePortsStopped({ cwd }) {
    return withAllocationLock(cwd, () => assertClaimedPortsStopped(cwd));
}

export async function terminateWorktreePortListeners({ cwd }) {
    const currentWorktree = resolve(getGitOutput(cwd, ["rev-parse", "--show-toplevel"]));
    return withAllocationLock(cwd, async () => {
        const parsed = parsePortConfiguration(await readEnvironment(join(currentWorktree, ".env.worktree")));
        const listeners = claimedPortListeners(parsed.claimedEntries);
        if (listeners.length === 0) {
            await assertNoUnidentifiedListener(parsed.claimedEntries);
            return { forceKilled: [], terminated: [] };
        }

        for (const { pid, ports } of listeners) {
            console.log(`Terminating PID ${pid} for managed port(s): ${formatListenerPorts(ports)}`);
        }
        signalListeners(listeners, "SIGTERM");

        const remaining = await waitForClaimedPortListeners(parsed.claimedEntries);
        if (remaining.length === 0) {
            await assertNoUnidentifiedListener(parsed.claimedEntries);
            return { forceKilled: [], terminated: listeners };
        }

        for (const { pid, ports } of remaining) {
            console.log(`Force killing PID ${pid} for managed port(s): ${formatListenerPorts(ports)}`);
        }
        signalListeners(remaining, "SIGKILL");

        const survivors = await waitForClaimedPortListeners(parsed.claimedEntries);
        if (survivors.length > 0) {
            throw new Error(
                `Failed to stop managed worktree port listener(s): ${survivors
                    .map(({ pid, ports }) => `PID ${pid} (${formatListenerPorts(ports)})`)
                    .join(", ")}`,
            );
        }
        await assertNoUnidentifiedListener(parsed.claimedEntries);
        return { forceKilled: remaining, terminated: listeners };
    });
}

async function retainPortClaim(cwd) {
    const currentWorktree = resolve(getGitOutput(cwd, ["rev-parse", "--show-toplevel"]));
    const envPath = join(currentWorktree, ".env.worktree");
    return withAllocationLock(cwd, async () => {
        const parsed = parsePortConfiguration(await readEnvironment(envPath));
        if (parsed.status !== "valid") {
            throw new Error("Cannot retain an incomplete or invalid worktree port claim");
        }
        await atomicWriteEnvironment(envPath, renderPortConfiguration("", parsed.ports));
        return parsed.ports;
    });
}

async function validatePortClaim(cwd) {
    const currentWorktree = resolve(getGitOutput(cwd, ["rev-parse", "--show-toplevel"]));
    const parsed = parsePortConfiguration(await readEnvironment(join(currentWorktree, ".env.worktree")));
    if (parsed.status !== "valid") {
        throw new Error("Worktree port claim is incomplete or invalid");
    }
    return parsed.ports;
}

function formatPorts(ports) {
    return PORT_SPECS.map(({ name }) => `${name}=${ports[name]}`).join(", ");
}

async function main() {
    const command = process.argv[2];
    const cwd = process.cwd();

    if (["ensure", "preflight", "repair"].includes(command)) {
        const result = await runPortAllocation({ cwd, mode: command });
        const verb = result.action === "preserved" ? "Using" : "Allocated";
        console.log(`${verb} worktree ports: ${formatPorts(result.ports)}`);
        return;
    }
    if (command === "assert-stopped") {
        await assertWorktreePortsStopped({ cwd });
        console.log("Managed worktree ports are not listening");
        return;
    }
    if (command === "terminate") {
        const result = await terminateWorktreePortListeners({ cwd });
        if (result.terminated.length === 0) {
            console.log("No managed worktree port listeners found");
        } else {
            console.log("Managed worktree port listeners stopped");
        }
        return;
    }
    if (command === "retain") {
        const ports = await retainPortClaim(cwd);
        console.log(`Retained worktree port claim: ${formatPorts(ports)}`);
        return;
    }
    if (command === "validate") {
        const ports = await validatePortClaim(cwd);
        console.log(`Valid worktree port claim: ${formatPorts(ports)}`);
        return;
    }
    throw new Error(
        "Usage: scripts/worktree/port-allocator.mjs <ensure|preflight|repair|assert-stopped|terminate|retain|validate>",
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch((error) => {
        console.error(`Port allocation failed: ${error.message}`);
        process.exitCode = 1;
    });
}
