import type { AgentApp, SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentModelEffort } from "@moxt-ai/mobius-sdk/protocol";
import { AcpExecutionError } from "../acp-error.ts";

export type AcpEndpointTermination =
    | { readonly kind: "closed" }
    | { readonly kind: "failed"; readonly error: AcpExecutionError };

export function acpEndpointTerminationError(termination: AcpEndpointTermination): AcpExecutionError {
    switch (termination.kind) {
        case "failed":
            return termination.error;
        case "closed":
            return new AcpExecutionError("The ACP endpoint is closed", {}, "acp_endpoint_closed");
        default: {
            const unreachable: never = termination;
            return unreachable;
        }
    }
}

/**
 * An ACP Agent that Mobius hosts inside the daemon instead of spawning as an adapter process.
 *
 * The implementation owns whatever it needs to serve ACP for one session — typically a vendor CLI
 * child process speaking that vendor's own protocol — and exposes it as a plain ACP `AgentApp`. The
 * daemon connects its normal ACP client to that app for control requests. Session updates use an
 * awaited local callback so producers wait for consumption instead of only transport delivery.
 *
 * Ownership is explicit: `initialize` prepares the backing resources, and `close` releases them and
 * every process they started, on success, failure, and cancellation alike.
 */
export interface InProcessAcpEndpoint {
    /** Reports when the endpoint becomes unusable, even without a pending RPC. Never rejects; close awaits cleanup. */
    readonly terminated: Promise<AcpEndpointTermination>;
    /** The ACP agent app the daemon connects its client to. */
    readonly app: () => AgentApp;
    /** Native identity of the current or most recently started turn, when the vendor exposes one. */
    readonly nativeTurnId?: () => string | null;
    /** Complete model-effort metadata already verified while initializing this endpoint, when available. */
    readonly agentSettingsModelEffort?: () => AgentModelEffort;
    /** Prepares the backing resources and completes any vendor handshake. */
    readonly initialize: (signal: AbortSignal) => Promise<void>;
    /** Releases the backing resources and every process they started. */
    readonly close: () => Promise<void>;
}

/** The verified local inputs an endpoint is allowed to launch from. */
export interface InProcessAcpEndpointOptions {
    /** The vendor executable, already resolved and revalidated by discovery. */
    /** Local lifecycle evidence only; never inferred from persisted or remote ACP metadata. */
    readonly onBackgroundActivity?: (active: boolean) => void;
    readonly command: string;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    /** Resolves after Mobius processes the update, backpressuring the local producer. */
    readonly onSessionUpdate: (notification: SessionNotification) => Promise<void>;
}

/**
 * Creates one endpoint per session. An Agent specification supplies this so discovery, the readiness
 * probe, and the session manager can host an in-process Agent without naming a vendor.
 */
export type InProcessAcpEndpointFactory = (options: InProcessAcpEndpointOptions) => InProcessAcpEndpoint;
