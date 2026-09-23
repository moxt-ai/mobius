import * as v from "valibot";

export const sessionAccessRecordSchema = v.pipe(
    v.object({
        credential_id: v.string(),
        secret_digest: v.string(),
        project_id: v.string(),
        session_id: v.string(),
        parent_credential_id: v.string(),
        parent_revision: v.pipe(v.number(), v.safeInteger()),
        expires_at: v.pipe(v.number(), v.safeInteger()),
    }),
    v.readonly(),
);
export type SessionAccessRecord = v.InferOutput<typeof sessionAccessRecordSchema>;
