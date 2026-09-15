import { z } from "zod";

export const organizationInviteTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const organizationInviteRequestSchema = z.strictObject({ token: organizationInviteTokenSchema }).readonly();
export const organizationInviteSchema = z
    .strictObject({
        id: z.string().uuid(),
        createdAt: z.number().int().nonnegative(),
        expiresAt: z.number().int().nonnegative(),
        role: z.literal("org:member"),
    })
    .readonly();
export const organizationInviteListSchema = z.array(organizationInviteSchema).readonly();
export const createdOrganizationInviteSchema = z
    .strictObject({
        ...organizationInviteSchema.unwrap().shape,
        token: organizationInviteTokenSchema,
    })
    .readonly();
export const organizationInvitePreviewSchema = z
    .strictObject({
        organizationId: z.string().regex(/^org_[a-zA-Z0-9]+$/),
        organizationName: z.string().min(1).max(256),
        member: z.boolean(),
    })
    .readonly();
export type OrganizationInvite = z.infer<typeof organizationInviteSchema>;
export type OrganizationInvitePreview = z.infer<typeof organizationInvitePreviewSchema>;
