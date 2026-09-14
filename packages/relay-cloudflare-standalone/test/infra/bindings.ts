import { env } from "cloudflare:workers";

export function testBindings() {
    const tenantId = env.MOBIUS_TENANT_ID;
    if (tenantId === undefined) {
        throw new Error("Expected the Standalone tenant binding");
    }
    return { ...env, MOBIUS_TENANT_ID: tenantId };
}
