import { readdirSync } from "node:fs";
import { join } from "node:path";

export function installedDirectories(directory: string): readonly string[] {
    try {
        return readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    } catch (cause) {
        if (
            cause instanceof Error &&
            "code" in cause &&
            (cause.code === "ENOENT" || cause.code === "ENOTDIR" || cause.code === "EACCES")
        ) {
            return [];
        }
        throw cause;
    }
}

export function claudeDesktopExecutablePaths(
    roots: readonly string[],
    executablePaths: readonly (readonly string[])[],
): readonly string[] {
    const paths: string[] = [];
    for (const root of roots) {
        const versions = installedDirectories(root)
            .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
            .toSorted((left, right) => right.localeCompare(left, "en", { numeric: true }));
        for (const version of versions) {
            const directory = join(root, version);
            // Current Desktop builds use checksum directories; older versions install directly.
            const installations = [
                directory,
                ...installedDirectories(directory).map((build) => join(directory, build)),
            ];
            for (const installation of installations) {
                for (const executablePath of executablePaths) {
                    paths.push(join(installation, ...executablePath));
                }
            }
        }
    }
    return paths;
}
