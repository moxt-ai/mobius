import { execFile } from "node:child_process";
import { chmod, lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export class LocalPathError extends Error {
    readonly code = "unsafe_local_path";

    constructor(message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.name = "LocalPathError";
    }
}

// The path is data in the environment, never interpolated into PowerShell source.
const windowsPermissions = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$item = Get-Item -LiteralPath $env:MORTY_PERMISSION_PATH -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe path' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $item.FullName
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier])
if ($owner -ne $sid -and -not ($owner.Value -eq 'S-1-5-32-544' -and ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) { throw 'Path is not user-owned' }
if ($env:MORTY_PERMISSION_PRIVATE -eq '1') {
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

export async function validateLocalPath(
    path: string,
    directory: boolean,
    privateAccess: boolean,
    signal: AbortSignal,
): Promise<void> {
    signal.throwIfAborted();
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || (directory ? !metadata.isDirectory() : !metadata.isFile())) {
        throw new LocalPathError("Unsafe local path");
    }
    if (process.platform === "win32") {
        const systemRoot = process.env["SystemRoot"];
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
                        MORTY_PERMISSION_PATH: path,
                        MORTY_PERMISSION_PRIVATE: privateAccess ? "1" : "0",
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
        return;
    }
    if (process.getuid === undefined || metadata.uid !== process.getuid()) {
        throw new LocalPathError("Path is not user-owned");
    }
    if (privateAccess) {
        await chmod(path, directory ? 0o700 : 0o600);
    }
}
