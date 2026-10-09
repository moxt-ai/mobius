export type RuntimeConnectionAppearance = "connecting" | "offline" | "online" | "unavailable";

export abstract class RuntimeConnectionState {
    abstract readonly appearance: RuntimeConnectionAppearance;
    abstract readonly canSend: boolean;
    abstract readonly description: string;
    abstract readonly label: string;
}

export class ConnectingRuntimeState extends RuntimeConnectionState {
    readonly appearance = "connecting";
    readonly canSend = false;
    readonly description = "Connecting to the local runtime…";
    readonly label = "Connecting";
}

export class ReconnectingRuntimeState extends RuntimeConnectionState {
    readonly appearance = "connecting";
    readonly canSend = false;
    readonly description = "Reconnecting the browser to the Mobius relay…";
    readonly label = "Reconnecting";
}

export class OnlineRuntimeState extends RuntimeConnectionState {
    readonly appearance = "online";
    readonly canSend = true;
    readonly description = "Connected through the local Mobius relay";
    readonly label = "Runtime online";
}

export class OfflineRuntimeState extends RuntimeConnectionState {
    readonly appearance = "offline";
    readonly canSend = false;
    readonly description = "The local runtime is offline. Management operations are unavailable.";
    readonly label = "Runtime offline";
}

export class UnavailableRuntimeState extends RuntimeConnectionState {
    readonly appearance = "unavailable";
    readonly canSend = false;
    readonly description = "The relay is unavailable. Start the local stack, then reload this page.";
    readonly label = "Relay unavailable";
}
