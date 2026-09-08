#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT_SPECS = [
    { base: 8787, name: "MOBIUS_RELAY_PORT" },
    { base: 5190, name: "MOBIUS_WEB_PORT" },
];
const MAX_TCP_PORT = 65_535;
const FIRST_WORKTREE_OFFSET = 1;
const PREFERRED_OFFSET_COUNT = 99;
const MANAGED_OFFSET_COUNT = Math.min(...PORT_SPECS.map(({ base }) => MAX_TCP_PORT - base)) + 1;
const LOCK_NAME = "mobius-worktree-ports.lock";
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 5 * 60_000;
const PORT_NAMES = new Set(PORT_SPECS.map(({ name }) => name));
const ENVIRONMENT_MARKER = "# Managed by scripts/worktree/port-allocator.mjs";

function delay(milliseconds) {
    return new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
    });
}

function gitOutput(cwd, arguments_) {
    return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function gitCommonDirectory(cwd) {
    const commonDirectory = gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return isAbsolute(commonDirectory) ? commonDirectory : resolve(cwd, commonDirectory);
}

function currentWorktree(cwd) {
    return resolve(gitOutput(cwd, ["rev-parse", "--show-toplevel"]));
}

function listWorktrees(cwd) {
    return gitOutput(cwd, ["worktree", "list", "--porcelain"])
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => resolve(line.slice("worktree ".length)));
}

async function readText(path) {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}

function parsePort(rawValue) {
    if (!/^\d+$/.test(rawValue)) {
        return null;
    }
    const port = Number(rawValue);
    return Number.isSafeInteger(port) && port >= 1 && port <= MAX_TCP_PORT ? port : null;
}

function isManagedPort(name, port) {
    const spec = PORT_SPECS.find((candidate) => candidate.name === name);
    if (spec === undefined || port === null) {
        return false;
    }
    const offset = port - spec.base;
    return offset >= FIRST_WORKTREE_OFFSET && offset < MANAGED_OFFSET_COUNT;
}

function parsePortConfiguration(content) {
    const valuesByName = new Map(PORT_SPECS.map(({ name }) => [name, []]));
    for (const line of content.split(/\r?\n/)) {
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (match === null || !PORT_NAMES.has(match[1])) {
            continue;
        }
        valuesByName.get(match[1]).push(parsePort(match[2]));
    }

    const ports = {};
    const allPortsPresent = PORT_SPECS.every(({ name }) => {
        const values = valuesByName.get(name);
        if (values.length !== 1 || !isManagedPort(name, values[0])) {
            return false;
        }
        ports[name] = values[0];
        return true;
    });
    const valid = allPortsPresent && new Set(Object.values(ports)).size === PORT_SPECS.length;
    const presentCount = [...valuesByName.values()].reduce((total, values) => total + values.length, 0);
    const claimedEntries = PORT_SPECS.flatMap(({ name }) =>
        valuesByName
            .get(name)
            .filter((port) => port !== null)
            .map((port) => ({ name, port })),
    );
    return {
        claimedEntries,
        ports: valid ? ports : null,
        status: valid ? "valid" : presentCount === 0 ? "missing" : "invalid",
    };
}

function renderPortConfiguration(content, ports) {
    const retainedLines = content.split(/\r?\n/).filter((line) => {
        const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
        return line !== ENVIRONMENT_MARKER && (match === null || !PORT_NAMES.has(match[1]));
    });
    while (retainedLines.at(-1) === "") {
        retainedLines.pop();
    }
    if (retainedLines.length > 0) {
        retainedLines.push("");
    }
    retainedLines.push(ENVIRONMENT_MARKER, ...PORT_SPECS.map(({ name }) => `${name}=${ports[name].toString()}`));
    return `${retainedLines.join("\n")}\n`;
}

async function atomicWrite(path, content) {
    const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
    let handle;
    try {
        handle = await open(temporaryPath, "wx", 0o600);
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, path);
        await chmod(path, 0o600);
    } catch (error) {
        if (handle !== undefined) {
            await handle.close().catch(() => {});
        }
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
    }
}

function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
    }
}

async function lockIsStale(lockDirectory) {
    try {
        const owner = JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
        if (owner.hostname === hostname() && Number.isSafeInteger(owner.pid) && !processIsAlive(owner.pid)) {
            return true;
        }
        return Date.now() - owner.createdAt > LOCK_STALE_MS;
    } catch {
        const lockStatus = await stat(lockDirectory);
        return Date.now() - lockStatus.mtimeMs > LOCK_STALE_MS;
    }
}

async function acquireLock(commonDirectory) {
    const lockDirectory = join(commonDirectory, LOCK_NAME);
    const token = randomUUID();
    const startedAt = Date.now();
    while (true) {
        let lockCreated = false;
        try {
            await mkdir(lockDirectory, { mode: 0o700 });
            lockCreated = true;
            await atomicWrite(
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
            if (lockCreated) {
                await rm(lockDirectory, { recursive: true });
                throw error;
            }
            if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
                throw error;
            }
        }

        if (await lockIsStale(lockDirectory)) {
            const staleDirectory = `${lockDirectory}.stale-${token}`;
            try {
                await rename(lockDirectory, staleDirectory);
                await rm(staleDirectory, { recursive: true });
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                    throw error;
                }
            }
            continue;
        }
        if (Date.now() - startedAt >= LOCK_WAIT_MS) {
            throw new Error(`Timed out waiting for the port lock at ${lockDirectory}`);
        }
        await delay(50);
    }
}

async function releaseLock(lock) {
    try {
        const owner = JSON.parse(await readFile(join(lock.lockDirectory, "owner.json"), "utf8"));
        if (owner.token === lock.token) {
            await rm(lock.lockDirectory, { recursive: true });
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }
}

async function withLock(cwd, callback) {
    const lock = await acquireLock(gitCommonDirectory(cwd));
    try {
        return await callback();
    } finally {
        await releaseLock(lock);
    }
}

async function persistedClaims(cwd, activeWorktree) {
    const claims = new Map();
    for (const worktree of listWorktrees(cwd)) {
        if (worktree === activeWorktree) {
            continue;
        }
        const parsed = parsePortConfiguration(await readText(join(worktree, ".env.worktree")));
        for (const { port } of parsed.claimedEntries) {
            const owners = claims.get(port) ?? [];
            owners.push(worktree);
            claims.set(port, owners);
        }
    }
    return claims;
}

function preferredOffset(worktree) {
    const hash = createHash("sha256").update(worktree).digest();
    return FIRST_WORKTREE_OFFSET + (hash.readUInt32BE(0) % PREFERRED_OFFSET_COUNT);
}

function bundleForOffset(offset) {
    return Object.fromEntries(PORT_SPECS.map(({ base, name }) => [name, base + offset]));
}

function* allocationOffsets(firstOffset) {
    for (let attempt = 0; attempt < PREFERRED_OFFSET_COUNT; attempt += 1) {
        yield FIRST_WORKTREE_OFFSET + ((firstOffset - FIRST_WORKTREE_OFFSET + attempt) % PREFERRED_OFFSET_COUNT);
    }
    for (let offset = FIRST_WORKTREE_OFFSET + PREFERRED_OFFSET_COUNT; offset < MANAGED_OFFSET_COUNT; offset += 1) {
        yield offset;
    }
}

function closeServer(server) {
    return new Promise((resolveClose) => {
        server.close(resolveClose);
    });
}

async function reservePorts(ports) {
    const servers = [];
    for (const { name } of PORT_SPECS.filter(({ name }) => ports[name] !== undefined)) {
        const server = createServer();
        try {
            await new Promise((resolveListen, rejectListen) => {
                server.once("error", rejectListen);
                server.listen({ exclusive: true, host: "127.0.0.1", port: ports[name] }, resolveListen);
            });
            servers.push(server);
        } catch (error) {
            await Promise.all(servers.map(closeServer));
            if (error instanceof Error && "code" in error && (error.code === "EADDRINUSE" || error.code === "EACCES")) {
                return { available: false, servers: [] };
            }
            throw error;
        }
    }
    return { available: true, servers };
}

async function allocate(cwd, mode) {
    const worktree = currentWorktree(cwd);
    const environmentPath = join(worktree, ".env.worktree");
    return await withLock(cwd, async () => {
        const content = await readText(environmentPath);
        const parsed = parsePortConfiguration(content);
        const claims = await persistedClaims(cwd, worktree);
        const claimedElsewhere = parsed.ports !== null && Object.values(parsed.ports).some((port) => claims.has(port));

        if (mode === "ensure" && parsed.ports !== null && !claimedElsewhere) {
            await chmod(environmentPath, 0o600);
            return { action: "preserved", ports: parsed.ports };
        }

        if (mode === "repair" && parsed.claimedEntries.length > 0) {
            const claimedPorts = Object.fromEntries(parsed.claimedEntries.map(({ name, port }) => [name, port]));
            const existingReservation = await reservePorts(claimedPorts);
            if (!existingReservation.available) {
                throw new Error(
                    "A currently claimed development port is still listening; stop pnpm dev before repairing ports",
                );
            }
            await Promise.all(existingReservation.servers.map(closeServer));
        }

        const firstOffset = preferredOffset(worktree);
        for (const offset of allocationOffsets(firstOffset)) {
            const ports = bundleForOffset(offset);
            if (
                new Set(Object.values(ports)).size !== PORT_SPECS.length ||
                Object.values(ports).some((port) => claims.has(port))
            ) {
                continue;
            }
            const reservation = await reservePorts(ports);
            if (!reservation.available) {
                continue;
            }
            try {
                await atomicWrite(environmentPath, renderPortConfiguration(content, ports));
            } finally {
                await Promise.all(reservation.servers.map(closeServer));
            }
            return { action: "allocated", ports };
        }
        throw new Error("No free Mobius worktree port bundle is available");
    });
}

async function validate(cwd) {
    const worktree = currentWorktree(cwd);
    const parsed = parsePortConfiguration(await readText(join(worktree, ".env.worktree")));
    if (parsed.ports === null) {
        throw new Error("The worktree port configuration is missing or invalid");
    }
    const claims = await persistedClaims(cwd, worktree);
    if (Object.values(parsed.ports).some((port) => claims.has(port))) {
        throw new Error("The worktree port configuration conflicts with another worktree");
    }
    return parsed.ports;
}

async function assertStopped(cwd) {
    const ports = await validate(cwd);
    const reservation = await reservePorts(ports);
    if (!reservation.available) {
        throw new Error("A managed development port is still listening; stop pnpm dev before continuing");
    }
    await Promise.all(reservation.servers.map(closeServer));
    return ports;
}

function formatPorts(ports) {
    return PORT_SPECS.map(({ name }) => `${name}=${ports[name].toString()}`).join(", ");
}

async function main() {
    const command = process.argv[2];
    const cwd = process.cwd();
    if (command === "ensure" || command === "repair") {
        const result = await allocate(cwd, command);
        const verb = result.action === "preserved" ? "Using" : "Allocated";
        process.stdout.write(`${verb} worktree ports: ${formatPorts(result.ports)}\n`);
        return;
    }
    if (command === "validate") {
        const ports = await validate(cwd);
        process.stdout.write(`Valid worktree ports: ${formatPorts(ports)}\n`);
        return;
    }
    if (command === "assert-stopped") {
        const ports = await assertStopped(cwd);
        process.stdout.write(`Worktree ports are stopped: ${formatPorts(ports)}\n`);
        return;
    }
    throw new Error("Usage: scripts/worktree/port-allocator.mjs <ensure|repair|validate|assert-stopped>");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch((error) => {
        const message = error instanceof Error ? error.message : "Unknown failure";
        process.stderr.write(`Port allocation failed: ${message}\n`);
        process.exitCode = 1;
    });
}
