import {
  type ManagedAgentArchiveDefinition,
  TarGzipManagedAgentArchiveDefinition,
  ZipManagedAgentArchiveDefinition,
} from "./managed-agent-archive.ts";

export const OPENCODE_MANAGED_VERSION = "1.18.29";

function releaseUrl(asset: string): URL {
  return new URL(
    `https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_MANAGED_VERSION}/${asset}`,
  );
}

export function openCodeManagedArchive(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): ManagedAgentArchiveDefinition {
  if (platform === "darwin" && architecture === "arm64") {
    const asset = "opencode-darwin-arm64.zip";
    return new ZipManagedAgentArchiveDefinition(
      OPENCODE_MANAGED_VERSION,
      asset,
      releaseUrl(asset),
      "fe764f7f360c584a83e18dd5f23fb1a6b2725f5ee8854b0252fe558f7798e946",
      "opencode",
    );
  }
  if (platform === "darwin" && architecture === "x64") {
    const asset = "opencode-darwin-x64.zip";
    return new ZipManagedAgentArchiveDefinition(
      OPENCODE_MANAGED_VERSION,
      asset,
      releaseUrl(asset),
      "9858853e7bacdbbd22c2d70c377e009dc4b354dd04f5588705411e7afb89fd2d",
      "opencode",
    );
  }
  if (platform === "linux" && architecture === "arm64") {
    const asset = "opencode-linux-arm64.tar.gz";
    return new TarGzipManagedAgentArchiveDefinition(
      OPENCODE_MANAGED_VERSION,
      asset,
      releaseUrl(asset),
      "70baf769395ca4e7a68924026530c390eace194f3b7e4919d4efcb2aa2eed3c0",
      "opencode",
    );
  }
  if (platform === "linux" && architecture === "x64") {
    const asset = "opencode-linux-x64.tar.gz";
    return new TarGzipManagedAgentArchiveDefinition(
      OPENCODE_MANAGED_VERSION,
      asset,
      releaseUrl(asset),
      "ea800b7ff56226b70952126c9fc1e2517ca4c4b5682fd9d3f9e87449697a1194",
      "opencode",
    );
  }
  throw new Error(
    "OpenCode does not publish an approved archive for this platform",
  );
}
