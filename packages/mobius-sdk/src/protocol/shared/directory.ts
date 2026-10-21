import { z } from "zod";

export const MAX_WORKSPACE_PATH_LENGTH = 4_096;
// One UTF-16 code unit takes at most three UTF-8 bytes, or four base64 characters.
export const MAX_DIRECTORY_IDENTIFIER_LENGTH = "path-".length + MAX_WORKSPACE_PATH_LENGTH * 4;
export const DIRECTORY_IDENTIFIER_PATTERN = new RegExp(
    `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,${MAX_DIRECTORY_IDENTIFIER_LENGTH - 1}}$`,
    "u",
);
export const DIRECTORY_IDENTIFIER = z
    .string()
    .min(1)
    .max(MAX_DIRECTORY_IDENTIFIER_LENGTH)
    .regex(DIRECTORY_IDENTIFIER_PATTERN);
export const isDirectoryIdentifier = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= MAX_DIRECTORY_IDENTIFIER_LENGTH &&
    DIRECTORY_IDENTIFIER_PATTERN.test(value);
