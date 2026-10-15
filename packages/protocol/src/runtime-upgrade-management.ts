import { z } from "zod";
import { runtimeUpgradeResultSchema, runtimeUpgradeVersionSchema } from "./runtime-upgrade.ts";
export const appUpgradeInputSchema = z
    .strictObject({ version: runtimeUpgradeVersionSchema, percentage: z.number().int().min(0).max(100) })
    .readonly();
export const appUpgradeTaskSchema = z
    .object({
        version: runtimeUpgradeVersionSchema,
        percentage: z.number().int().min(0).max(100),
        revision: z.string(),
        updatedAt: z.number(),
    })
    .readonly();
export const appUpgradeTaskResponseSchema = z.object({ task: appUpgradeTaskSchema.nullable() }).readonly();
export const storedUpgradeResultSchema = z
    .object({ receivedAt: z.number(), result: runtimeUpgradeResultSchema })
    .readonly();
export const runtimeUpgradeSnapshotSchema = z
    .object({
        runtimeId: z.string(),
        projectId: z.string(),
        name: z.string(),
        matched: z.boolean(),
        connection: z.enum(["online", "offline", "unknown"]),
        lastSeen: z.number().nullable(),
        version: z.string().nullable(),
        attempt: z
            .object({ requestId: z.string(), revision: z.string(), version: z.string(), sentAt: z.number() })
            .readonly()
            .nullable(),
        latest: storedUpgradeResultSchema.nullable(),
        lastFailure: storedUpgradeResultSchema.nullable(),
    })
    .readonly();
export const runtimeUpgradePageSchema = z
    .object({
        task: appUpgradeTaskSchema.nullable(),
        runtimes: z.array(runtimeUpgradeSnapshotSchema).readonly(),
        next: z.string().nullable(),
        queriedAt: z.number(),
    })
    .readonly();
export type AppUpgradeTask = z.infer<typeof appUpgradeTaskSchema>;
export type AppUpgradeInput = z.infer<typeof appUpgradeInputSchema>;
export type RuntimeUpgradeSnapshot = z.infer<typeof runtimeUpgradeSnapshotSchema>;
export type RuntimeUpgradePage = z.infer<typeof runtimeUpgradePageSchema>;

export function isRuntimeUpgradeNeeded(current: string, target: string): boolean {
    const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?$/.exec(value);
    const left = parse(current),
        right = parse(target);
    if (left === null || right === null) {
        return false;
    }
    for (let index = 1; index <= 3; index++) {
        const a = BigInt(left[index] ?? "0"),
            b = BigInt(right[index] ?? "0");
        if (a !== b) {
            return a < b;
        }
    }
    if (left[4] === right[4] || left[4] === undefined) {
        return false;
    }
    if (right[4] === undefined) {
        return true;
    }
    const a = left[4].split("."),
        b = right[4].split(".");
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const x = a[index],
            y = b[index];
        if (x === y) {
            continue;
        }
        if (x === undefined) {
            return true;
        }
        if (y === undefined) {
            return false;
        }
        const numericX = /^\d+$/.test(x),
            numericY = /^\d+$/.test(y);
        if (numericX && numericY) {
            return BigInt(x) < BigInt(y);
        }
        if (numericX !== numericY) {
            return numericX;
        }
        return x < y;
    }
    return false;
}
