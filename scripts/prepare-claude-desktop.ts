import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createZstdDecompress } from "node:zlib";
import { extractFile, listPackage } from "@electron/asar";

const releaseOrigin = "https://downloads.claude.ai/claude-code-releases";
const run = promisify(execFile);
const signal = AbortSignal.timeout(5 * 60_000);

function object(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Invalid Claude Desktop manifest object");
    }
    return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, pattern: RegExp): string {
    if (typeof value !== "string" || !pattern.test(value)) {
        throw new Error("Invalid Claude Desktop manifest field");
    }
    return value;
}

// Read the distribution's build pin as data. Never import or evaluate Desktop application code.
async function readDistribution(resources: string): Promise<Record<string, unknown>> {
    const candidates = new Map<string, Record<string, unknown>>();
    for (const entry of listPackage(resources, { isPack: false })) {
        signal.throwIfAborted();
        if (!/^\/\.vite\/build\/[^/]+\.js$/.test(entry)) {
            continue;
        }
        const source = extractFile(resources, entry.slice(1)).toString("utf8");
        for (const match of source.matchAll(/JSON\.parse\('((?:\\.|[^'\\])*)'\)/g)) {
            const literal = match[1];
            if (literal === undefined || !literal.includes(releaseOrigin)) {
                continue;
            }
            const decoded: unknown = JSON.parse(literal);
            const distribution = object(decoded);
            if (distribution["baseUrl"] === releaseOrigin) {
                candidates.set(literal, distribution);
            }
        }
    }
    const distribution = [...candidates.values()];
    if (distribution.length !== 1 || distribution[0] === undefined) {
        throw new Error("Expected exactly one Claude Code build manifest in the Desktop distribution");
    }
    return distribution[0];
}

async function download(url: string, path: string, checksum: string, expectedSize: unknown): Promise<void> {
    if (
        typeof expectedSize !== "number" ||
        !Number.isSafeInteger(expectedSize) ||
        expectedSize <= 0 ||
        expectedSize > 512 * 1024 * 1024
    ) {
        throw new Error("Invalid Desktop engine archive size");
    }
    const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        redirect: "error",
    });
    if (!response.ok || response.body === null) {
        throw new Error(`Desktop engine download failed: HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const file = await open(path, "wx");
    const hash = createHash("sha256");
    let bytes = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }
            bytes += chunk.value.byteLength;
            if (bytes > expectedSize) {
                throw new Error("Desktop engine archive exceeds its declared size");
            }
            hash.update(chunk.value);
            await file.writeFile(chunk.value);
        }
        if (bytes !== expectedSize || hash.digest("hex") !== checksum) {
            throw new Error("Desktop engine archive checksum or size mismatch");
        }
    } finally {
        await reader.cancel();
        await file.close();
    }
}

const resourcesArgument = process.argv[2];
const cacheArgument = process.argv[3];
if (
    resourcesArgument === undefined ||
    cacheArgument === undefined ||
    !isAbsolute(resourcesArgument) ||
    !isAbsolute(cacheArgument)
) {
    throw new Error("Usage: node scripts/prepare-claude-desktop.ts <app.asar-file> <engine-cache-directory>");
}
if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("Desktop compatibility requires Windows or macOS");
}
if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Unsupported Desktop architecture");
}
const resources = resolve(resourcesArgument);
const cache = resolve(cacheArgument);
const distribution = await readDistribution(resources);
const version = text(distribution["version"], /^\d+\.\d+\.\d+$/);
const manifest = object(distribution["manifest"]);
if (manifest["version"] !== version) {
    throw new Error("Desktop build pin and engine manifest disagree");
}
const platform = `${process.platform}-${process.arch}`;
const target = object(object(manifest["platforms"])[platform]);
let archiveName: string;
let archiveMetadata: Record<string, unknown>;
let relativeBinary: string[];
if (process.platform === "darwin") {
    archiveName = "claude.app.tar.zst";
    archiveMetadata = object(target["bundle"]);
    relativeBinary = ["claude.app", "Contents", "MacOS", "claude"];
} else {
    archiveName = text(target["binary"], /^claude\.exe\.zst$/);
    archiveMetadata = target;
    relativeBinary = ["claude.exe"];
}
const checksum = text(archiveMetadata["checksum"], /^[a-f0-9]{64}$/);
const install = join(cache, version, checksum.slice(0, 12));
await mkdir(install, { recursive: true });
const temporary = await mkdtemp(join(cache, ".download-"));
const binary = join(install, ...relativeBinary);
try {
    const archive = join(temporary, "engine.zst");
    await download(
        `${releaseOrigin}/${version}/${platform}/${archiveName}`,
        archive,
        checksum,
        archiveMetadata["size"],
    );
    if (process.platform === "darwin") {
        const tar = join(temporary, "engine.tar");
        await pipeline(createReadStream(archive), createZstdDecompress(), createWriteStream(tar, { flags: "wx" }), {
            signal,
        });
        const listing = await run("tar", ["-tf", tar], { signal, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
        for (const entry of listing.stdout.trim().split("\n")) {
            const path = entry.replace(/^\.\//, "");
            if ((path !== "claude.app" && !path.startsWith("claude.app/")) || path.split("/").includes("..")) {
                throw new Error("Unsafe Desktop bundle entry");
            }
        }
        await run("tar", ["-xf", tar, "-C", install], { signal, timeout: 60_000 });
    } else {
        await pipeline(createReadStream(archive), createZstdDecompress(), createWriteStream(binary, { flags: "wx" }), {
            signal,
        });
    }
    await chmod(binary, 0o755);
    const reported = await run(binary, ["--version"], { signal, timeout: 30_000, windowsHide: true });
    if (reported.stdout.trim() !== `${version} (Claude Code)`) {
        throw new Error("Downloaded engine disagrees with the Desktop build pin");
    }
    const packageJson: unknown = JSON.parse(extractFile(resources, "package.json").toString("utf8"));
    const desktopVersion = text(object(packageJson)["version"], /^\d+(?:\.\d+)+$/);
    const result = { desktopVersion, engineVersion: version, platform, checksum, binary };
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/claude-desktop-distribution.json", `${JSON.stringify(result, null, 2)}\n`);
    const environment = process.env["GITHUB_ENV"];
    if (environment !== undefined) {
        await appendFile(environment, `MOBIUS_TEST_CLAUDE_PATH=${binary}\nMOBIUS_DESKTOP_ENGINE_VERSION=${version}\n`);
    }
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined) {
        await appendFile(
            summary,
            `## Claude Desktop distribution compatibility\n\nDesktop: ${desktopVersion}\n\nEngine: ${version}\n\nPlatform: ${platform}\n\nArchive SHA-256: ${checksum}\n\nThis verifies the Desktop-selected engine through Mobius, not a signed-in GUI session.\n`,
        );
    }
    console.log(JSON.stringify(result));
} finally {
    await rm(temporary, { recursive: true, force: true });
}
