export interface SessionConfigPanelKeyContext {
    readonly key: string;
    readonly selectMenuOpen: boolean;
}

export type SessionConfigPanelKeyAction = "close" | "continue" | "keep-open";

export function sessionConfigPanelKeyAction({
    key,
    selectMenuOpen,
}: SessionConfigPanelKeyContext): SessionConfigPanelKeyAction {
    if (key !== "Escape") {
        return "continue";
    }
    return selectMenuOpen ? "keep-open" : "close";
}
