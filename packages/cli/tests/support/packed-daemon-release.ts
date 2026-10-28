import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import cliPackage from "../../package.json" with { type: "json" };
import { findExecutableOnPath, runBoundedProcess } from "../../src/engine/util/process/executable.ts";

// The npm registry stores real packed releases; the Relay stores catalogs and
// remains online across replacement processes. Neither replaces product code.
export async function packedRelease(
    directory: string,
    version: string,
    broken: boolean,
    signal: AbortSignal,
    options: { readonly node?: string; readonly smokeFailure?: boolean } = {},
): Promise<Buffer> {
    const root = join(directory, version);
    await mkdir(join(root, "dist"), { recursive: true });
    if (!broken) {
        const source = join(directory, `source-${version}`);
        await cp(resolve(import.meta.dirname, "../../src"), join(source, "src"), { recursive: true });
        await writeFile(join(source, "package.json"), JSON.stringify({ ...cliPackage, version }));
        await symlink(resolve(import.meta.dirname, "../../node_modules"), join(source, "node_modules"), "junction");
        await writeFile(
            join(root, "dist/cli.js"),
            `import ${JSON.stringify(pathToFileURL(join(source, "src/cli/entrypoint.ts")).href)};`,
        );
    } else {
        await writeFile(
            join(root, "dist/cli.js"),
            `${options.smokeFailure ? "" : `if (process.argv.includes('--version')) { console.log('CLI: ${version}'); process.exit(0); }`} console.log("Starting controlled release"); throw new Error("Controlled startup failure");`,
        );
    }
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({
            name: cliPackage.name,
            version,
            type: "module",
            bin: { mobius: "dist/cli.js" },
            files: ["dist"],
            engines: { node: options.node ?? cliPackage.engines.node },
        }),
    );
    const npm = await findExecutableOnPath("npm", process.env);
    if (npm === null) {
        throw new Error("npm is required by the upgrade scenario");
    }
    await runBoundedProcess({
        command: npm.path,
        arguments: ["pack", "--ignore-scripts", "--pack-destination", root],
        cwd: root,
        environment: process.env,
        signal,
        timeoutMilliseconds: 30_000,
    });
    return await readFile(join(root, `moxt-ai-mobius-${version}.tgz`));
}
