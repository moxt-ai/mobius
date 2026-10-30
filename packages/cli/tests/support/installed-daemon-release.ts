import { chmod, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
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
    const bin = join(stateRoot, "test-package-runner");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "latest.json"), JSON.stringify({ executable: process.execPath, entry, version }));
    const runner = `#!${process.execPath}\nimport {readFileSync} from 'node:fs';\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['--yes','--prefer-online','@moxt-ai/mobius@latest','__launch'])) process.exit(2);\nprocess.stdout.write(readFileSync(new URL('./latest.json', import.meta.url)));\n`;
    await writeFile(join(bin, "package.json"), '{"type":"module"}');
    await writeFile(join(bin, "npx"), runner);
    await chmod(join(bin, "npx"), 0o700);
    await writeFile(join(bin, "npx.cmd"), `@"${process.execPath}" "%~dp0npx" %*\r\n`);
}

export function workspaceDaemonEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
    const root = environment["MOBIUS_STATE_DIRECTORY"];
    if (root === undefined) {
        return { ...environment };
    }
    return {
        ...environment,
        PATH: [join(root, "test-package-runner"), environment["PATH"] ?? dirname(process.execPath)].join(delimiter),
    };
}
