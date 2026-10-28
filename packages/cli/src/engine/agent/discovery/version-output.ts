export function normalizeVersionOutput(output: string): string {
    return output.trim().split(/\r?\n/, 1)[0]?.trim().slice(0, 128) ?? "";
}
