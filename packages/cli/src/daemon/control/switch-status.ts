import { sendLocalRequest } from "./local-client.ts";
import { type DaemonReleaseSwitchState, lifecycleResponse } from "./protocol.ts";

export async function readSwitchStatus(
    directory: string,
    signal: AbortSignal,
    wait = false,
): Promise<DaemonReleaseSwitchState | null> {
    const response = lifecycleResponse.parse(
        await sendLocalRequest(directory, "manager", { kind: "switch-status", wait }, signal),
    );
    if (response.kind !== "switch-status") {
        throw new Error("The manager could not return the switch status");
    }
    return response.state;
}
