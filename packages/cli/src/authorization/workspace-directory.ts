import { readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
} from "node:path";

import type { WorkspaceEntry } from "@moxt-ai/mobius-protocol";

import { LocalAuthorizationError } from "./authorize-binding.ts";

const ROOT_DIRECTORY_ID = "root";
const DIRECTORY_ID_PREFIX = "dir-";
const DIRECTORY_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

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

function directoryId(relativePath: string): string {
  if (relativePath.length === 0) {
    return ROOT_DIRECTORY_ID;
  }
  return `${DIRECTORY_ID_PREFIX}${Buffer.from(relativePath, "utf8").toString("base64url")}`;
}

function decodeDirectoryId(value: string): string {
  if (value === ROOT_DIRECTORY_ID) {
    return "";
  }
  if (!value.startsWith(DIRECTORY_ID_PREFIX)) {
    throw new LocalAuthorizationError("The workspace directory is invalid");
  }
  const encoded = value.slice(DIRECTORY_ID_PREFIX.length);
  if (
    encoded.length === 0 ||
    encoded.length > 2_000 ||
    !DIRECTORY_ID_PATTERN.test(encoded)
  ) {
    throw new LocalAuthorizationError("The workspace directory is invalid");
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
    throw new LocalAuthorizationError("The workspace directory is invalid");
  }
  const normalized = normalize(decoded);
  if (
    decoded.includes("\0") ||
    isAbsolute(decoded) ||
    normalized === ".." ||
    normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    normalized !== decoded
  ) {
    throw new LocalAuthorizationError("The workspace directory is invalid");
  }
  return normalized;
}

function isContained(root: string, target: string): boolean {
  const remainder = relative(root, target);
  return (
    remainder.length === 0 ||
    (!isAbsolute(remainder) &&
      remainder !== ".." &&
      !remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

export class WorkspaceDirectoryService {
  readonly #approvedBindingId: string;
  readonly #approvedRoot: string;

  constructor(approvedBindingId: string, approvedRoot: string) {
    this.#approvedBindingId = approvedBindingId;
    this.#approvedRoot = approvedRoot;
  }

  readonly resolve = async (
    requestedBindingId: string,
    requestedDirectoryId: string,
  ): Promise<string> => {
    if (requestedBindingId !== this.#approvedBindingId) {
      throw new LocalAuthorizationError(
        "The runtime binding is not authorized",
      );
    }
    const root = await this.resolveRoot();
    const relativePath = decodeDirectoryId(requestedDirectoryId);
    try {
      const target = await realpath(join(root, relativePath));
      const metadata = await stat(target);
      if (!metadata.isDirectory() || !isContained(root, target)) {
        throw new LocalAuthorizationError(
          "The workspace directory is not authorized",
        );
      }
      return target;
    } catch (error) {
      if (error instanceof LocalAuthorizationError) {
        throw error;
      }
      throw new LocalAuthorizationError(
        "The workspace directory cannot be resolved",
        { cause: error },
      );
    }
  };

  readonly list = async (
    requestedBindingId: string,
    requestedDirectoryId: string,
  ): Promise<WorkspaceDirectoryListing> => {
    const root = await this.resolveRoot();
    const logicalRelativePath = decodeDirectoryId(requestedDirectoryId);
    const target = await this.resolve(requestedBindingId, requestedDirectoryId);
    try {
      const entries: WorkspaceEntry[] = [];
      const children = await readdir(target, { withFileTypes: true });
      for (const child of children) {
        if (entries.length === 500) {
          break;
        }
        const logicalChild =
          logicalRelativePath.length === 0
            ? child.name
            : join(logicalRelativePath, child.name);
        try {
          const resolvedChild = await realpath(join(target, child.name));
          const metadata = await stat(resolvedChild);
          if (metadata.isDirectory() && isContained(root, resolvedChild)) {
            entries.push({
              directoryId: directoryId(logicalChild),
              name: child.name,
            });
          }
        } catch {
          // Unreadable and broken directory entries are omitted.
        }
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const labelSuffix = logicalRelativePath.replaceAll("\\", "/");
      const parentRelative =
        logicalRelativePath.length === 0 || dirname(logicalRelativePath) === "."
          ? ""
          : dirname(logicalRelativePath);
      return new WorkspaceDirectoryListing(
        requestedDirectoryId,
        labelSuffix.length === 0
          ? basename(root)
          : `${basename(root)}/${labelSuffix}`,
        entries,
        requestedDirectoryId === ROOT_DIRECTORY_ID
          ? ""
          : directoryId(parentRelative),
      );
    } catch (error) {
      if (error instanceof LocalAuthorizationError) {
        throw error;
      }
      throw new LocalAuthorizationError(
        "The workspace directory cannot be listed",
        { cause: error },
      );
    }
  };

  readonly resolveMany = async (
    requestedBindingId: string,
    directoryIds: readonly string[],
  ): Promise<readonly string[]> => {
    const resolved: string[] = [];
    const unique = new Set<string>();
    for (const requestedDirectoryId of directoryIds) {
      const directory = await this.resolve(
        requestedBindingId,
        requestedDirectoryId,
      );
      if (!unique.has(directory)) {
        unique.add(directory);
        resolved.push(directory);
      }
    }
    return resolved;
  };

  readonly resolveRoot = async (): Promise<string> => {
    try {
      const root = await realpath(this.#approvedRoot);
      const metadata = await stat(root);
      if (!metadata.isDirectory()) {
        throw new LocalAuthorizationError(
          "The approved root is not a directory",
        );
      }
      return root;
    } catch (error) {
      if (error instanceof LocalAuthorizationError) {
        throw error;
      }
      throw new LocalAuthorizationError(
        "The approved root cannot be resolved",
        {
          cause: error,
        },
      );
    }
  };
}
