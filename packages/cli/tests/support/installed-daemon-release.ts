import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cliPackage from "../../package.json" with { type: "json" };

// Lifecycle scenarios start with an installed release and run the production CLI.
// The registry journey separately covers downloading and installing that release.
// Test command prehooks build this bundle once, avoiding source transpilation on every managed process restart.
export async function installWorkspaceDaemonRelease(
    stateRoot: string,
    version = cliPackage.version,
    entry = resolve(import.meta.dirname, "../../dist/cli.js"),
): Promise<void> {
    const root = join(stateRoot, "npm", version, "node_modules", "@moxt-ai", "mobius");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ ...cliPackage, version }));
    await writeFile(join(root, "dist", "cli.js"), `import ${JSON.stringify(pathToFileURL(entry).href)};`);
}

export function workspaceDaemonEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
    return { ...environment };
}
