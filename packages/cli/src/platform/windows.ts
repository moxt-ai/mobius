import { type ChildProcess, execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { LocalPathError } from "../filesystem/path-error.ts";
import { ProcessExecutionError } from "../util/process/process-error.ts";
import type { PlatformSupport, ProcessLaunch, ProcessTableEntry, ProcessTreeIdentity } from "./contracts.ts";
import { parseProcessTable, processExists } from "./posix.ts";

const execute = promisify(execFile);

function environmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string): string | undefined {
    return Object.entries(environment).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
}

function installedDirectories(directory: string): readonly string[] {
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

function desktopClaudeExecutablePaths(environment: Readonly<NodeJS.ProcessEnv>): readonly string[] {
    const roots: string[] = [];
    const localAppData = environmentValue(environment, "LOCALAPPDATA");
    if (localAppData !== undefined && isAbsolute(localAppData)) {
        const dataDirectory = join(localAppData, "Claude-Data");
        for (const installation of installedDirectories(dataDirectory)) {
            if (installation.startsWith("claude_")) {
                roots.push(join(dataDirectory, installation, "claude-code"));
            }
        }
    }
    const appData = environmentValue(environment, "APPDATA");
    if (appData !== undefined && isAbsolute(appData)) {
        roots.push(join(appData, "Claude", "claude-code"));
    }
    const paths: string[] = [];
    for (const root of roots) {
        const versions = installedDirectories(root)
            .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
            .toSorted((left, right) => right.localeCompare(left, "en", { numeric: true }));
        for (const version of versions) {
            const directory = join(root, version);
            // Desktop can keep the engine directly under its version or in a build-hash directory.
            paths.push(join(directory, "claude.exe"));
            for (const build of installedDirectories(directory)) {
                paths.push(join(directory, build, "claude.exe"));
            }
        }
    }
    return paths;
}

function executableExtensions(executableName: string, environment: Readonly<NodeJS.ProcessEnv>): readonly string[] {
    if (/\.[a-zA-Z0-9]+$/.test(executableName)) {
        return [""];
    }
    const configured = environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
    const extensions = configured
        .split(";")
        .map((extension) => extension.trim())
        .filter((extension) => extension.length > 0)
        .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
    return extensions.length > 0 ? extensions : [".EXE"];
}

async function resolveExecutableTarget(path: string): Promise<string> {
    let resolvedPath: string;
    try {
        resolvedPath = await realpath(extname(path) === "" ? `${path}.cmd` : path);
    } catch (cause) {
        if (extname(path) !== "" || !(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") {
            throw cause;
        }
        resolvedPath = await realpath(path);
    }
    if (extname(resolvedPath).toLowerCase() === ".cmd") {
        // npm cmd-shim entrypoints are Node scripts. Resolve the script instead of
        // handing untrusted arguments to cmd.exe's command language.
        const shim = await readFile(resolvedPath, "utf8");
        // Node's bundled npm uses its own shim format, not npm cmd-shim.
        if (
            shim.includes('SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"') &&
            shim.includes('"%NODE_EXE%" "%NPM_CLI_JS%" %*')
        ) {
            return await realpath(resolve(dirname(resolvedPath), "node_modules/npm/bin/npm-cli.js"));
        }
        const script = /"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*/iu.exec(shim)?.[1];
        if (script !== undefined && shim.includes("SET dp0=%~dp0")) {
            resolvedPath = await realpath(resolve(dirname(resolvedPath), script));
        } else {
            const pnpmScript = /^\s*node\s+"%~dp0[\\/]([^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*\s*$/imu.exec(shim)?.[1];
            if (pnpmScript === undefined || !shim.includes("@SETLOCAL")) {
                throw new ProcessExecutionError(
                    "process_unsupported_script",
                    "Use a native executable or a verified Node entrypoint",
                );
            }
            resolvedPath = await realpath(resolve(dirname(resolvedPath), pnpmScript));
        }
    }
    return resolvedPath;
}

function executableLaunch(command: string, args: readonly string[]): ProcessLaunch {
    if (/\.(?:js|mjs|cjs)$/iu.test(command)) {
        return { command: process.execPath, arguments: [command, ...args] };
    }
    if (/\.(?:cmd|bat)$/iu.test(command)) {
        throw new ProcessExecutionError(
            "process_unsupported_script",
            "Use a native executable or a verified Node entrypoint",
        );
    }
    return { command, arguments: args };
}

function readProcessTable(): Promise<readonly ProcessTableEntry[]> {
    const systemRoot = environmentValue(process.env, "SystemRoot");
    if (systemRoot === undefined) {
        return Promise.resolve([]);
    }
    return new Promise((resolveTable) => {
        execFile(
            join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {0}' -f $_.ProcessId, $_.ParentProcessId }",
            ],
            {
                encoding: "utf8",
                windowsHide: true,
                timeout: 10000,
                signal: AbortSignal.timeout(10000),
                maxBuffer: 1024 * 1024,
            },
            (error, stdout) => resolveTable(error === null ? parseProcessTable(stdout) : []),
        );
    });
}

function signalCapturedProcesses(
    processes: readonly ProcessTreeIdentity[],
    _rootProcessId: number,
    signal: number,
): void {
    for (const identity of [...processes].reverse()) {
        try {
            process.kill(identity.processId, signal);
        } catch {
            // A concurrently exited process no longer needs cleanup.
        }
    }
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
        return;
    }
    child.kill(signal);
}

// The path is data in the environment, never interpolated into PowerShell source.
const windowsPermissions = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$item = Get-Item -LiteralPath $env:MOBIUS_PERMISSION_PATH -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe path' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $item.FullName
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($owner -ne $sid -and -not ($owner.Value -eq 'S-1-5-32-544' -and ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) { throw 'Path is not user-owned' }
if ($env:MOBIUS_PERMISSION_PRIVATE -eq '1') {
    if ($item.PSIsContainer) {
        $private = New-Object Security.AccessControl.DirectorySecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
        $private = New-Object Security.AccessControl.FileSecurity
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    }
    $private.SetOwner($sid)
    $private.SetAccessRuleProtection($true, $false)
    $private.AddAccessRule($rule)
    Set-Acl -LiteralPath $item.FullName -AclObject $private
}
`;

async function validatePathPermissions(
    path: string,
    _directory: boolean,
    privateAccess: boolean,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const systemRoot = environmentValue(process.env, "SystemRoot");
    if (systemRoot === undefined) {
        throw new LocalPathError("Windows system directory is unavailable");
    }
    try {
        await execute(
            join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(windowsPermissions, "utf16le").toString("base64"),
            ],
            {
                env: {
                    ...process.env,
                    MOBIUS_PERMISSION_PATH: path,
                    MOBIUS_PERMISSION_PRIVATE: privateAccess ? "1" : "0",
                },
                windowsHide: true,
                signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
                timeout: 10000,
                maxBuffer: 16384,
            },
        );
    } catch (cause) {
        signal.throwIfAborted();
        throw new LocalPathError("The local path permissions could not be secured", { cause });
    }
}

export const windowsPlatform: PlatformSupport = {
    controlSocketPath: (installationHash) => `\\\\.\\pipe\\mobius-${installationHash}`,
    prepareControlSocket: async () => {},
    secureControlSocket: async () => {},
    removeControlSocket: async () => {},

    pathDelimiter: ";",
    environmentValue,
    executableExtensions,
    resolveExecutableTarget,
    executableLaunch,
    spawnOptions: { detached: false, windowsHide: true },
    signalCapturedProcesses,
    terminateProcess,
    validatePathPermissions,
    readProcessTable,
    readProcessTableSynchronously: () => [],
    processExists,
    claudeCodeExecutablePaths: (environment) => {
        const paths: string[] = [];
        const userProfile = environmentValue(environment, "USERPROFILE");
        if (userProfile !== undefined && isAbsolute(userProfile)) {
            paths.push(join(userProfile, ".local", "bin", "claude.exe"));
        }
        const localAppData = environmentValue(environment, "LOCALAPPDATA");
        if (localAppData !== undefined && isAbsolute(localAppData)) {
            paths.push(join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"));
        }
        paths.push(...desktopClaudeExecutablePaths(environment));
        return paths;
    },
};
