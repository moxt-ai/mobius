import { platformSupportFor } from "../platform/index.ts";
import {
    type ManagedAgentArchiveDefinition,
    TarGzipManagedAgentArchiveDefinition,
    ZipManagedAgentArchiveDefinition,
} from "./managed-agent-archive.ts";

export const OPENCODE_MANAGED_VERSION = "1.18.29";

function releaseUrl(asset: string): URL {
    return new URL(`https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_MANAGED_VERSION}/${asset}`);
}

export function openCodeManagedArchive(
    platform: NodeJS.Platform,
    architecture: NodeJS.Architecture,
): ManagedAgentArchiveDefinition {
    const release = platformSupportFor(platform).openCodeArchives[architecture];
    if (release === undefined) {
        throw new Error("OpenCode does not publish an approved archive for this platform");
    }
    const Definition = {
        zip: ZipManagedAgentArchiveDefinition,
        "tar.gz": TarGzipManagedAgentArchiveDefinition,
    }[release.format];
    return new Definition(
        OPENCODE_MANAGED_VERSION,
        release.asset,
        releaseUrl(release.asset),
        release.sha256,
        "opencode",
    );
}
