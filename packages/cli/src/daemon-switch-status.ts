import { requestParentManager } from "./daemon/lifecycle/parent-ipc.ts";
import { type DaemonSwitchState, lifecycleResponse } from "./daemon-lifecycle-protocol.ts";

export async function readSwitchStatus(signal: AbortSignal, wait = false): Promise<DaemonSwitchState | null> {
    const response = lifecycleResponse.parse(await requestParentManager({ kind: "switch-status", wait }, signal));
    if (response.kind !== "switch-status") {
        throw new Error("The manager could not return the switch status");
    }
    return response.state;
}
