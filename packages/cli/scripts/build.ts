import { readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { build } from "esbuild";
import { z } from "zod";

const directory = resolve(import.meta.dirname, "..");
const noticePath = resolve(directory, "NOTICE");
const licensesPath = resolve(directory, "THIRD-PARTY-NOTICES.txt");

// Remove previous chunks and notices together so the archive contains one build.
await rm(resolve(directory, "dist"), { recursive: true, force: true });
await rm(noticePath, { force: true });
await rm(licensesPath, { force: true });

const result = await build({
    absWorkingDir: directory,
    entryPoints: { cli: "src/cli/entrypoint.ts", engine: "src/exports/engine.ts" },
    bundle: true,
    splitting: true,
    platform: "node",
    target: "node22.19.0",
    format: "esm",
    sourcemap: true,
    outbase: "src",
    outdir: "dist",
    external: ["@agentclientprotocol/sdk", "undici"],
    metafile: true,
    logLevel: "info",
});

const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"));
const packageDirectories = new Set<string>();
for (const input of inputs) {
    const parts = input.split("/");
    const nodeModules = parts.lastIndexOf("node_modules");
    if (nodeModules === -1) {
        continue;
    }
    const first = parts[nodeModules + 1];
    if (first === undefined) {
        throw new Error(`Cannot identify bundled package: ${input}`);
    }
    const end = nodeModules + (first.startsWith("@") ? 3 : 2);
    packageDirectories.add(resolve(directory, ...parts.slice(0, end)));
}

const packageSchema = z.object({ name: z.string().min(1), version: z.string().min(1), license: z.string().min(1) });
const sections: { readonly name: string; readonly text: string }[] = [];

async function readLicense(root: string, file: string): Promise<string> {
    const base = await realpath(root);
    const requested = resolve(base, file);
    for (const target of [requested, await realpath(requested)]) {
        const path = relative(base, target);
        if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")) {
            throw new Error(`License reference escapes its component: ${file}`);
        }
    }
    const text = await readFile(requested, "utf8");
    if (text.trim().length === 0) {
        throw new Error(`Empty license or notice: ${file}`);
    }
    return text;
}

for (const packageDirectory of packageDirectories) {
    const raw: unknown = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8"));
    const metadata = packageSchema.parse(raw);
    const name = `${metadata.name}@${metadata.version}`;
    const entries = await readdir(packageDirectory, { withFileTypes: true });
    const files = new Set(
        entries
            .filter(
                (entry) => entry.isFile() && /^(?:licen[cs]e|notice|copying|copyright)(?:$|[._-])/i.test(entry.name),
            )
            .map((entry) => entry.name),
    );
    const referencedLicense = /^SEE LICEN[CS]E IN (.+)$/i.exec(metadata.license)?.[1];
    if (referencedLicense !== undefined) {
        files.add(referencedLicense);
    }
    const texts = [`Component: ${name}\nDeclared license: ${metadata.license}\n`];
    if (
        referencedLicense === undefined &&
        ![...files].some((file) => /^(?:licen[cs]e|copying)(?:$|[._-])/i.test(file))
    ) {
        // This release omits LICENSE from its npm archive. Retain the unmodified
        // license from its exact upstream release; upgrades must be checked again.
        if (name !== "drizzle-orm@1.0.0-rc.4" || metadata.license !== "Apache-2.0") {
            throw new Error(`Bundled package has no license text: ${name}`);
        }
        const source =
            "https://github.com/drizzle-team/drizzle-orm/blob/748058e837d9c4247330e3d45580cbdae52bffda/LICENSE";
        const text = await readLicense(directory, "licenses/drizzle-orm-LICENSE");
        texts.push(`--- LICENSE (upstream: ${source}) ---\n${text}`);
    }
    for (const file of [...files].sort()) {
        const text = await readLicense(packageDirectory, file);
        texts.push(`--- ${file} ---\n${text}`);
    }
    sections.push({ name, text: texts.join("\n") });
}

// These adapters are copied source, so they have no node_modules package boundary.
for (const adapter of [
    { name: "Claude ACP adapter (claude-code-acp)", path: "src/engine/acp/harness/claude" },
    { name: "Pi ACP adapter (pi-acp)", path: "src/engine/acp/harness/pi" },
]) {
    if (!inputs.some((input) => input.startsWith(`${adapter.path}/upstream/`))) {
        continue;
    }
    const text = await readLicense(resolve(directory, adapter.path), "LICENSE");
    sections.push({ name: adapter.name, text: `Component: ${adapter.name}\n\n${text}` });
}

sections.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
await writeFile(
    licensesPath,
    [
        "Third-party notices for code bundled in the Mobius CLI.\nEach component retains its own license and terms.\n",
        ...sections.map((section) => section.text),
    ].join(`\n${"-".repeat(80)}\n\n`),
);
const notice = await readFile(resolve(directory, "../../NOTICE"), "utf8");
await writeFile(
    noticePath,
    `${notice}\nSource paths above refer to the Mobius source repository.\nLicense texts and notices for bundled components are included in\nTHIRD-PARTY-NOTICES.txt alongside this file.\n`,
);
