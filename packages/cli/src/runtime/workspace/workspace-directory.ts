import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative } from "node:path";
import type { WorkspaceEntry } from "@moxt-ai/mobius-sdk/protocol";
import { LocalAuthorizationError } from "./local-authorization-error.ts";

export class WorkspaceDirectoryListing {
    readonly directoryId: string;
    readonly directoryLabel: string;
    readonly entries: readonly WorkspaceEntry[];
    readonly parentDirectoryId: string;
    constructor(
        directoryId: string,
        directoryLabel: string,
        entries: readonly WorkspaceEntry[],
        parentDirectoryId: string,
    ) {
        this.directoryId = directoryId;
        this.directoryLabel = directoryLabel;
        this.entries = entries;
        this.parentDirectoryId = parentDirectoryId;
    }
}

function encodePath(path: string): string {
    const encoded = Buffer.from(path, "utf8").toString("base64url");
    if (encoded.length === 0 || encoded.length > 2_000) {
        throw new LocalAuthorizationError("The local directory path is too long to select");
    }
    return `path-${encoded}`;
}

function expandCurrentUserHome(path: string): string {
    // Adapted from https://github.com/sindresorhus/untildify/blob/main/index.js.
    return path.replace(/^~(?=$|\/|\\)/, homedir());
}

function decodePath(value: string, prefix: string): string {
    const encoded = value.slice(prefix.length);
    if (encoded.length === 0 || encoded.length > 2_000 || !/^[a-zA-Z0-9_-]+$/.test(encoded)) {
        throw new LocalAuthorizationError("The directory identifier is invalid");
    }
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const normalized =
        process.platform === "win32" && decoded.startsWith("~/")
            ? normalize(decoded).replaceAll("\\", "/")
            : normalize(decoded);
    if (
        Buffer.from(decoded, "utf8").toString("base64url") !== encoded ||
        decoded.includes("\0") ||
        normalized !== decoded
    ) {
        throw new LocalAuthorizationError("The directory identifier is invalid");
    }
    return decoded;
}

/** Pairing authorizes the machine. Directory identifiers select a working
 * directory; they do not grant additional filesystem capabilities. */
export class WorkspaceDirectoryService {
    readonly #bindingId: string;
    readonly #defaultWorkspace: string;

    constructor(bindingId: string, defaultWorkspace: string) {
        this.#bindingId = bindingId;
        this.#defaultWorkspace = defaultWorkspace;
    }

    private readonly authorizeMachine = (bindingId: string): void => {
        if (bindingId !== this.#bindingId) {
            throw new LocalAuthorizationError("The runtime binding is not authorized");
        }
    };

    private readonly requestedPath = (id: string): string => {
        if (id === "default") {
            return this.#defaultWorkspace;
        }
        if (id === "home") {
            return homedir();
        }
        if (id.startsWith("path-")) {
            const path = expandCurrentUserHome(decodePath(id, "path-"));
            if (isAbsolute(path)) {
                return path;
            }
        }
        throw new LocalAuthorizationError("The directory identifier is invalid");
    };

    private readonly resolvePath = async (requested: string, signal: AbortSignal): Promise<string> => {
        signal.throwIfAborted();
        if (!isAbsolute(requested) || requested.includes("\0") || normalize(requested) !== requested) {
            throw new LocalAuthorizationError("The local directory path is invalid");
        }
        try {
            const target = await realpath(requested);
            signal.throwIfAborted();
            const metadata = await stat(target);
            signal.throwIfAborted();
            if (!isAbsolute(target) || normalize(target) !== target || !metadata.isDirectory()) {
                throw new LocalAuthorizationError("The selected location is not a directory");
            }
            return target;
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof LocalAuthorizationError) {
                throw cause;
            }
            throw new LocalAuthorizationError("This directory is missing or unavailable to your user account", {
                cause,
            });
        }
    };

    private readonly label = (path: string): string => {
        const suffix = relative(homedir(), path);
        return suffix === ""
            ? "~"
            : !isAbsolute(suffix) &&
                suffix !== ".." &&
                !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
              ? `~/${suffix.replaceAll("\\", "/")}`
              : path;
    };

    readonly identify = async (
        bindingId: string,
        requestedPath: string,
        signal: AbortSignal,
    ): Promise<{
        readonly path: string;
        readonly directoryId: string;
        readonly name: string;
        readonly label: string;
    }> => {
        this.authorizeMachine(bindingId);
        const path = await this.resolvePath(requestedPath, signal);
        return {
            path,
            directoryId: encodePath(path),
            name: basename(path) || path,
            label: this.label(path),
        };
    };

    readonly resolve = async (bindingId: string, id: string, signal: AbortSignal): Promise<string> => {
        this.authorizeMachine(bindingId);
        return await this.resolvePath(this.requestedPath(id), signal);
    };

    readonly list = async (bindingId: string, id: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing> => {
        const target = await this.resolve(bindingId, id, signal);
        try {
            const children = await readdir(target, { withFileTypes: true });
            signal.throwIfAborted();
            const entries: WorkspaceEntry[] = [];
            for (const child of children) {
                if (entries.length === 500) {
                    break;
                }
                if (
                    child.isFile() ||
                    child.isBlockDevice() ||
                    child.isCharacterDevice() ||
                    child.isFIFO() ||
                    child.isSocket()
                ) {
                    continue;
                }
                try {
                    const path = await this.resolvePath(join(target, child.name), signal);
                    entries.push({ directoryId: encodePath(path), name: child.name });
                } catch (cause) {
                    signal.throwIfAborted();
                    if (!(cause instanceof LocalAuthorizationError)) {
                        throw cause;
                    }
                }
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            const parent = dirname(target);
            return new WorkspaceDirectoryListing(
                id,
                this.label(target),
                entries,
                parent === target ? "" : encodePath(parent),
            );
        } catch (cause) {
            signal.throwIfAborted();
            if (cause instanceof LocalAuthorizationError) {
                throw cause;
            }
            throw new LocalAuthorizationError("This directory cannot be browsed by your user account", { cause });
        }
    };

    readonly resolveMany = async (
        bindingId: string,
        ids: readonly string[],
        signal: AbortSignal,
    ): Promise<readonly string[]> => {
        const paths = new Set<string>();
        for (const id of ids) {
            paths.add(await this.resolve(bindingId, id, signal));
        }
        return [...paths];
    };
}
