import { type DaemonSwitchState, lifecycleResponse } from "./daemon-lifecycle-protocol.ts";
import { sendLocalRequest } from "./daemon-local-control.ts";

export async function readSwitchStatus(
    directory: string,
    signal: AbortSignal,
    wait = false,
): Promise<DaemonSwitchState | null> {
    const response = lifecycleResponse.parse(
        await sendLocalRequest(directory, "manager", { kind: "switch-status", wait }, signal),
    );
    if (response.kind !== "switch-status") {
        throw new Error("The manager could not return the switch status");
    }
    return response.state;
}
