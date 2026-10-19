import { type SessionCapabilities, SessionPromptDisposition } from "@moxt-ai/mobius-protocol";
import type { AgentDescriptor } from "../../entity/pairing/pairing.ts";
import { PairingDirectoryError } from "../../entity/pairing/pairing.ts";
import type { RuntimeControlCommand } from "./runtime-control-request.ts";

/**
 * The capability a command requires from the Agent that executes it. The
 * advertised capability document is advisory: it decides nothing until the
 * command is issued, and this contract is enforced at that moment.
 */
type RequiredCommandCapability =
    | { readonly kind: "none" }
    | {
          /** The exact Agent this command names; its advertisement decides. */
          readonly capability: keyof SessionCapabilities;
          readonly kind: "agent";
          readonly agentId: string;
      }
    | {
          /** No Agent is named, so any Agent on the Runtime can serve the command. */
          readonly capability: keyof SessionCapabilities;
          readonly kind: "runtime";
      };

function requiredCommandCapability(command: RuntimeControlCommand): RequiredCommandCapability {
    if (command.kind === "session.prompt" && command.disposition === SessionPromptDisposition.Steer) {
        return { agentId: command.agentId, capability: "steering", kind: "agent" };
    }
    if (command.kind === "session.prompt.disposition") {
        return { capability: "steering", kind: "runtime" };
    }
    if (command.kind === "session.rename") {
        return { capability: "renameSession", kind: "runtime" };
    }
    return { kind: "none" };
}

/**
 * Rejects a command whose required capability no Agent on the Runtime
 * advertises. Resolution deliberately fails open: when the named Agent is not
 * found, or the Runtime lists no Agents, the command reaches the Runtime and
 * the local execution boundary stays the authority for side effects.
 */
export function authorizeCommandCapability(command: RuntimeControlCommand, agents: readonly AgentDescriptor[]): void {
    const required = requiredCommandCapability(command);
    if (required.kind === "none") {
        return;
    }
    const failures: Partial<Record<keyof SessionCapabilities, string>> = {
        renameSession: "session_rename_unsupported",
        steering: "steering_unsupported",
    };
    const supported =
        required.kind === "agent"
            ? agents.find((agent) => agent.id === required.agentId)?.capabilities[required.capability]
            : agents.some((agent) => agent.capabilities[required.capability]);
    if (supported === true) {
        return;
    }
    if (required.kind === "agent" && !agents.some((agent) => agent.id === required.agentId)) {
        return;
    }
    if (agents.length === 0) {
        return;
    }
    const failure = failures[required.capability];
    if (failure === undefined) {
        return;
    }
    throw new PairingDirectoryError(failure, "The selected Agent does not support this command");
}
