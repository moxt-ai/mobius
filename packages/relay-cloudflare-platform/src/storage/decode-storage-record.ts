import * as v from "valibot";
import { PlatformControlPlaneError } from "../entity/platform-control-plane.ts";

export function decodeStorageRecord<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    record: unknown,
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, record);
    if (!result.success) {
        throw new PlatformControlPlaneError(
            "platform_record_invalid",
            "The Platform database returned an invalid record",
            500,
            { cause: new v.ValiError(result.issues) },
        );
    }
    return result.output;
}

export function decodeOptionalStorageRecord<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    record: unknown,
): v.InferOutput<TSchema> | null {
    return record === null ? null : decodeStorageRecord(schema, record);
}

export function decodeStorageRecords<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    schema: TSchema,
    records: unknown,
): readonly v.InferOutput<TSchema>[] {
    return decodeStorageRecord(v.array(schema), records);
}
