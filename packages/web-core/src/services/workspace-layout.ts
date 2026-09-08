export const DEFAULT_SIDEBAR_WIDTH = 264;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 380;
const SIDEBAR_COLLAPSE_THRESHOLD = 160;

export type DesktopSidebarLayoutState =
    | {
          readonly kind: "expanded";
          readonly width: number;
      }
    | {
          readonly kind: "collapsed";
          readonly rememberedWidth: number;
      };

function clampSidebarWidth(width: number): number {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validWidth(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? clampSidebarWidth(value) : undefined;
}

function readProperty(record: Readonly<Record<string, unknown>>, key: string): unknown {
    return record[key];
}

export function decodeSidebarLayoutPreference(serialized: string | null): DesktopSidebarLayoutState {
    if (serialized === null) {
        return { kind: "expanded", width: DEFAULT_SIDEBAR_WIDTH };
    }
    try {
        const parsed: unknown = JSON.parse(serialized);
        if (!isRecord(parsed)) {
            return { kind: "expanded", width: DEFAULT_SIDEBAR_WIDTH };
        }
        if (readProperty(parsed, "kind") === "expanded") {
            const width = validWidth(readProperty(parsed, "width"));
            return width === undefined
                ? { kind: "expanded", width: DEFAULT_SIDEBAR_WIDTH }
                : { kind: "expanded", width };
        }
        if (readProperty(parsed, "kind") === "collapsed") {
            const rememberedWidth = validWidth(readProperty(parsed, "rememberedWidth"));
            return rememberedWidth === undefined
                ? { kind: "expanded", width: DEFAULT_SIDEBAR_WIDTH }
                : { kind: "collapsed", rememberedWidth };
        }
    } catch {}
    return { kind: "expanded", width: DEFAULT_SIDEBAR_WIDTH };
}

export function encodeSidebarLayoutPreference(state: DesktopSidebarLayoutState): string {
    return JSON.stringify(state);
}

export function resizeSidebar(requestedWidth: number): DesktopSidebarLayoutState {
    return {
        kind: "expanded",
        width: clampSidebarWidth(requestedWidth),
    };
}

export function finishSidebarResize(
    state: DesktopSidebarLayoutState,
    requestedWidth: number,
): DesktopSidebarLayoutState {
    if (!Number.isFinite(requestedWidth)) {
        return state;
    }
    if (requestedWidth < SIDEBAR_COLLAPSE_THRESHOLD) {
        return {
            kind: "collapsed",
            rememberedWidth: state.kind === "expanded" ? state.width : state.rememberedWidth,
        };
    }
    return resizeSidebar(requestedWidth);
}

export function resetSidebar(): DesktopSidebarLayoutState {
    return { kind: "expanded", width: DEFAULT_SIDEBAR_WIDTH };
}

export function sidebarDisplayWidth(state: DesktopSidebarLayoutState): number {
    return state.kind === "expanded" ? state.width : 0;
}

export function toggleSidebar(state: DesktopSidebarLayoutState): DesktopSidebarLayoutState {
    return state.kind === "expanded"
        ? { kind: "collapsed", rememberedWidth: state.width }
        : { kind: "expanded", width: state.rememberedWidth };
}
