export async function rolloutMatches(runtimeId: string, percentage: number): Promise<boolean> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`mobius-runtime-rollout-v1:${runtimeId}`),
    );
    return new DataView(digest).getUint32(0, false) < Math.floor((2 ** 32 * percentage) / 100);
}
export { isRuntimeUpgradeNeeded as needsUpgrade } from "@moxt-ai/mobius-protocol";
