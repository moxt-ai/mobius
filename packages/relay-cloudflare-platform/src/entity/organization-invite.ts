import * as v from "valibot";

export const organizationInviteTokenSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));

export const organizationInviteRowSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    organization_id: v.pipe(v.string(), v.regex(/^org_[a-zA-Z0-9]+$/)),
    token_hash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    creator_id: v.string(),
    created_at: v.number(),
    expires_at: v.number(),
    revoked_at: v.nullable(v.number()),
});
export type OrganizationInviteRow = Readonly<v.InferOutput<typeof organizationInviteRowSchema>>;
