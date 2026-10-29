import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { z } from "zod";
import { failureCode, RelayProbeError } from "./config.ts";

const execute = promisify(execFile);
export const routeEvidenceSchema = z.object({
    hostname: z.string(),
    addresses: z.array(z.string()),
    routes: z.array(
        z.object({ address: z.string(), interface: z.string(), gateway: z.string(), tunnelInterface: z.boolean() }),
    ),
    failures: z.array(z.string()),
    omittedAddresses: z.number().int().nonnegative(),
});
export type RouteEvidence = z.infer<typeof routeEvidenceSchema>;

async function addresses(hostname: string, signal: AbortSignal): Promise<string[]> {
    if (isIP(hostname) !== 0) {
        return [hostname];
    }
    const aborted = Promise.withResolvers<never>();
    const abort = (): void => aborted.reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
        signal.throwIfAborted();
        const found = await Promise.race([lookup(hostname, { all: true }), aborted.promise]);
        return [...new Set(found.map((item) => item.address))];
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

export async function collectRouteEvidence(hostname: string, cancellation: AbortSignal): Promise<RouteEvidence> {
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(5_000)]);
    const evidence: RouteEvidence = { hostname, addresses: [], routes: [], failures: [], omittedAddresses: 0 };
    try {
        const resolved = await addresses(hostname.replace(/^\[|\]$/gu, ""), signal);
        evidence.addresses.push(...resolved.slice(0, 8));
        evidence.omittedAddresses = Math.max(0, resolved.length - evidence.addresses.length);
        await Promise.all(
            evidence.addresses.map(async (address) => {
                try {
                    let networkInterface = "";
                    let gateway = "";
                    if (process.platform === "darwin") {
                        const { stdout } = await execute("/sbin/route", ["-n", "get", address], {
                            signal,
                            timeout: 2_000,
                            maxBuffer: 32_768,
                        });
                        networkInterface = stdout.match(/^\s*interface:\s*(\S+)/mu)?.[1] ?? "";
                        gateway = stdout.match(/^\s*gateway:\s*(\S+)/mu)?.[1] ?? "";
                    } else if (process.platform === "linux") {
                        const { stdout } = await execute("ip", ["-json", "route", "get", address], {
                            signal,
                            timeout: 2_000,
                            maxBuffer: 32_768,
                        });
                        const result = z
                            .array(z.object({ dev: z.string(), gateway: z.string().optional() }))
                            .parse(JSON.parse(stdout));
                        networkInterface = result[0]?.dev ?? "";
                        gateway = result[0]?.gateway ?? "";
                    } else {
                        evidence.failures.push("route_platform_unsupported");
                        return;
                    }
                    if (networkInterface.length === 0) {
                        throw new RelayProbeError(
                            "route_interface_unavailable",
                            "The route did not identify an interface",
                        );
                    }
                    evidence.routes.push({
                        address,
                        interface: networkInterface,
                        gateway,
                        tunnelInterface: /^(?:utun|tun|tap|wg|tailscale)/u.test(networkInterface),
                    });
                } catch (error) {
                    cancellation.throwIfAborted();
                    evidence.failures.push(failureCode(error));
                }
            }),
        );
    } catch (error) {
        cancellation.throwIfAborted();
        evidence.failures.push(failureCode(error));
    }
    return evidence;
}
