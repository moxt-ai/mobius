import { env } from "cloudflare:workers";

export function testBindings() {
    return { ...env };
}
