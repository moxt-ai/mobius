import { z } from "zod";
import { type Identifier, isIdentifier } from "./identifier.ts";

// Remote requests select only an exact release of the fixed Mobius npm package.
export const runtimeUpgradeVersionSchema = z
    .string()
    .max(128)
    .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
export const runtimeUpgradeRequestSchema = z
    .strictObject({
        kind: z.literal("runtime.upgrade.request"),
        requestId: z.custom<Identifier>(isIdentifier),
        version: runtimeUpgradeVersionSchema,
    })
    .readonly();
export const runtimeUpgradeResultSchema = z
    .strictObject({
        kind: z.literal("runtime.upgrade.result"),
        requestId: z.custom<Identifier>(isIdentifier),
        version: runtimeUpgradeVersionSchema,
        targetVersion: runtimeUpgradeVersionSchema,
        outcome: z
            .discriminatedUnion("status", [
                z.strictObject({ status: z.literal("accepted") }),
                z.strictObject({ status: z.literal("succeeded") }),
                z.strictObject({
                    status: z.literal("failed"),
                    stdout: z.string().max(4096).optional(),
                    stderr: z.string().max(4096).optional(),
                    code: z.string().min(1).max(64),
                    message: z.string().max(256),
                    retryAfter: z.number().int().nonnegative(),
                }),
                z.strictObject({
                    status: z.literal("rejected"),
                    code: z.string().min(1).max(64),
                    message: z.string().max(256),
                    retryAfter: z.number().int().nonnegative(),
                }),
            ])
            .readonly(),
    })
    .readonly();
export type RuntimeUpgradeRequest = z.infer<typeof runtimeUpgradeRequestSchema>;
export type RuntimeUpgradeResult = z.infer<typeof runtimeUpgradeResultSchema>;
export const decodeRuntimeUpgradeRequest = (raw: string): RuntimeUpgradeRequest =>
    runtimeUpgradeRequestSchema.parse(JSON.parse(raw));
export const decodeRuntimeUpgradeResult = (raw: string): RuntimeUpgradeResult =>
    runtimeUpgradeResultSchema.parse(JSON.parse(raw));
export const encodeRuntimeUpgradeRequest = (value: RuntimeUpgradeRequest): string =>
    JSON.stringify(runtimeUpgradeRequestSchema.parse(value));
export const encodeRuntimeUpgradeResult = (value: RuntimeUpgradeResult): string =>
    JSON.stringify(runtimeUpgradeResultSchema.parse(value));
