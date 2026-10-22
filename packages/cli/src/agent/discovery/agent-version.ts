interface ParsedVersion {
    readonly core: readonly number[];
    readonly prerelease: readonly string[];
}

function parseVersion(value: string): ParsedVersion | null {
    const match = /(?:^|[^0-9])v?(\d+(?:\.\d+)+)(?:-([0-9A-Za-z.-]+))?/u.exec(value);
    if (match?.[1] === undefined) {
        return null;
    }
    return {
        core: match[1].split(".").map(Number),
        prerelease: match[2]?.split(".") ?? [],
    };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
    if (left.length === 0 || right.length === 0) {
        return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
    }
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const leftPart = left[index];
        const rightPart = right[index];
        if (leftPart === undefined || rightPart === undefined) {
            return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
        }
        if (leftPart === rightPart) {
            continue;
        }
        const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
        const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
        if (leftNumber !== null && rightNumber !== null) {
            return Math.sign(leftNumber - rightNumber);
        }
        if (leftNumber !== null || rightNumber !== null) {
            return leftNumber !== null ? -1 : 1;
        }
        return leftPart.localeCompare(rightPart);
    }
    return 0;
}

export function compareAgentVersions(left: string, right: string): number | null {
    const parsedLeft = parseVersion(left);
    const parsedRight = parseVersion(right);
    if (parsedLeft === null || parsedRight === null) {
        return null;
    }
    for (let index = 0; index < Math.max(parsedLeft.core.length, parsedRight.core.length); index += 1) {
        const difference = (parsedLeft.core[index] ?? 0) - (parsedRight.core[index] ?? 0);
        if (difference !== 0) {
            return Math.sign(difference);
        }
    }
    return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

export function isAgentVersionSupported(reportedVersion: string, minimumSupportedVersion: string): boolean | null {
    const comparison = compareAgentVersions(reportedVersion, minimumSupportedVersion);
    return comparison === null ? null : comparison >= 0;
}
