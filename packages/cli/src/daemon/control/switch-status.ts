import type { InstallationDirectory } from "../../engine/storage/installation/installation-files.ts";
import { sendLocalRequest } from "./local-client.ts";
import { type DaemonReleaseSwitchState, decodeKnownLifecycleResponse } from "./protocol.ts";

export async function readSwitchStatus(
    directory: InstallationDirectory,
    signal: AbortSignal,
    wait = false,
): Promise<DaemonReleaseSwitchState | null> {
    const response = decodeKnownLifecycleResponse(
        await sendLocalRequest(directory, "manager", { kind: "switch-status", wait }, signal),
    );
    if (response?.kind !== "switch-status") {
        throw new Error("The manager could not return the switch status");
    }
    return response.state;
}
