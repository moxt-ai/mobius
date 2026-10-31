/** Every permission a Project credential can grant. Servers and clients take the vocabulary from here. */
export const PROJECT_PERMISSION_NAMES = Object.freeze([
    "artifact:read",
    "artifact:write",
    "identity-binding:manage",
    "interaction:respond",
    "owner-credential:manage",
    "project:event:read",
    "project:read",
    "runtime:pair",
    "runtime:read",
    "runtime:revoke",
    "session:delete",
    "session:read",
    "session:write",
] as const);

export type ProjectPermissionName = (typeof PROJECT_PERMISSION_NAMES)[number];

/**
 * The permissions a Platform App credential may hold. The Platform issues an App's server credential with all of
 * them and requires all of them to provision Projects; the Dashboard requests them when it issues a credential.
 */
export const PLATFORM_APP_PROJECT_PERMISSIONS: readonly ProjectPermissionName[] = Object.freeze([
    "artifact:read",
    "artifact:write",
    "interaction:respond",
    "project:event:read",
    "project:read",
    "runtime:pair",
    "runtime:read",
    "runtime:revoke",
    "session:delete",
    "session:read",
    "session:write",
]);
