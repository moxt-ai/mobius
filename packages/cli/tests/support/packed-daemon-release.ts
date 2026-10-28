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
        // Stamp and bundle each release once, rather than transpiling its source graph on every CLI/daemon restart.
        const diagnostic = join(source, "bundle-error.txt");
        const runtimeDependencies = {
            "@agentclientprotocol/sdk": import.meta.resolve("@agentclientprotocol/sdk"),
            undici: import.meta.resolve("undici"),
        };
        await runBoundedProcess({
            command: process.execPath,
            arguments: [
                "--input-type=module",
                "--eval",
                // esbuild's extensionless bin entry can be JavaScript or a native binary. Its JS API is portable;
                // running it in a child keeps bundling bounded and cancellable without depending on PATH shims.
                `import { writeFile } from "node:fs/promises"; try { const { build } = await import(${JSON.stringify(import.meta.resolve("esbuild"))}); await build(JSON.parse(process.argv[1])); } catch (error) { await writeFile(process.argv[2], String(error).slice(0, 4000)); process.exitCode = 1; }`,
                JSON.stringify({
                    entryPoints: [join(source, "src/cli/entrypoint.ts")],
                    outfile: join(source, "dist/cli.js"),
                    // Windows fixtures can be on a different drive from the workspace's pnpm dependency junctions.
                    nodePaths: [resolve(import.meta.dirname, "../../node_modules")],
                    bundle: true,
                    platform: "node",
                    target: "node22.19.0",
                    format: "esm",
                    // Keep these dependencies external, but do not resolve them through a temporary junction at runtime.
                    alias: runtimeDependencies,
                    external: Object.values(runtimeDependencies),
                    logLevel: "silent",
                }),
                diagnostic,
            ],
            cwd: source,
            environment: process.env,
            signal,
            timeoutMilliseconds: 30_000,
        }).catch(async (cause: unknown) => {
            if (!signal.aborted) {
                const detail = await readFile(diagnostic, "utf8").catch(() => "No bundle diagnostic was written.");
                console.error(`Fixture release ${version} bundling failed: ${detail}`);
            }
            throw cause;
        });
        await writeFile(
            join(root, "dist/cli.js"),
            `import ${JSON.stringify(pathToFileURL(join(source, "dist/cli.js")).href)};`,
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
