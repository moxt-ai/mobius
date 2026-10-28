/** True when `error` is a Node.js system error with the given code, such as `ENOENT`. */
export function isNodeError(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
