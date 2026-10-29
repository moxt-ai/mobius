import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

class ProbeConfigurationFileError extends Error {
    readonly code = "probe_config_invalid";
}

export async function readPrivateProbeConfiguration(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const metadata = await stat(path);
    if (
        !metadata.isFile() ||
        metadata.size > 16_384 ||
        (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
        throw new ProbeConfigurationFileError(
            "The pairing configuration must be a private, small regular file (mode 0600)",
        );
    }
    try {
        return JSON.parse(await readFile(path, { encoding: "utf8", signal }));
    } catch {
        signal.throwIfAborted();
        throw new ProbeConfigurationFileError("The pairing configuration is not valid JSON");
    }
}

export async function createProbeOutput(directory: string): Promise<void> {
    // Exclusive creation prevents a diagnostic run from claiming existing state as its own.
    await mkdir(directory, { mode: 0o700 });
}

export async function ensureProbeDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function writeProbeReport(directory: string, report: unknown): Promise<void> {
    await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

export async function writeProbeEvents(
    directory: string,
    events: readonly Readonly<Record<string, string>>[],
): Promise<void> {
    await writeFile(join(directory, "transport.jsonl"), events.map((event) => JSON.stringify(event)).join("\n"), {
        mode: 0o600,
    });
}

export async function removeProbeState(directory: string): Promise<void> {
    await rm(join(directory, "state"), { recursive: true, force: true });
}
