import { z } from "zod";
import { readPrivateProbeConfiguration } from "../../../storage/diagnostics/relay-probe-files.ts";

const pairing = z.object({ pairingId: z.string().min(1).max(128), pairingCode: z.string().min(1).max(128) }).readonly();
const configuration = z.object({ relayOrigin: z.url(), direct: pairing, proxy: pairing }).readonly();
export type RelayProbeConfiguration = z.infer<typeof configuration>;
export type RelayProbeRole = "direct" | "proxy";

export class RelayProbeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

export async function readProbeConfiguration(path: string, signal: AbortSignal): Promise<RelayProbeConfiguration> {
    const value = await readPrivateProbeConfiguration(path, signal);
    const parsed = configuration.safeParse(value);
    if (!parsed.success) {
        throw new RelayProbeError(
            "probe_config_invalid",
            "Expected relayOrigin and direct/proxy pairingId and pairingCode",
        );
    }
    const config = parsed.data;
    const origin = new URL(config.relayOrigin);
    if (
        !["https:", "http:"].includes(origin.protocol) ||
        (origin.protocol === "http:" && !["127.0.0.1", "localhost"].includes(origin.hostname)) ||
        origin.username ||
        origin.password ||
        origin.search ||
        origin.hash ||
        origin.pathname !== "/"
    ) {
        throw new RelayProbeError(
            "probe_origin_invalid",
            "relayOrigin must use HTTPS (or loopback HTTP), without credentials or query parameters",
        );
    }
    if (config.direct.pairingId === config.proxy.pairingId || config.direct.pairingCode === config.proxy.pairingCode) {
        throw new RelayProbeError("probe_pairings_reused", "Direct and proxy probes require distinct, unused pairings");
    }
    return config;
}

export function configuredProbeProxy(): URL {
    const value =
        process.env["https_proxy"] ||
        process.env["HTTPS_PROXY"] ||
        process.env["http_proxy"] ||
        process.env["HTTP_PROXY"];
    let proxy: URL;
    try {
        proxy = new URL(value ?? "");
    } catch {
        throw new RelayProbeError("probe_proxy_missing", "Set HTTPS_PROXY or HTTP_PROXY to an HTTP or HTTPS proxy");
    }
    if (!["http:", "https:"].includes(proxy.protocol)) {
        throw new RelayProbeError("probe_proxy_invalid", "The comparison requires an HTTP or HTTPS proxy");
    }
    return proxy;
}

export function failureCode(error: unknown): string {
    const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
    return typeof code === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(code) ? code : "probe_failed";
}
