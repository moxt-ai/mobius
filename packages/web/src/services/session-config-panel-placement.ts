import {
    type FloatingPanelGeometry,
    type FloatingPanelMode,
    type FloatingPanelPlacement,
    type FloatingPanelViewport,
    floatingPanelMode,
    placeFloatingPanel,
} from "@/services/floating-panel-placement";

const PANEL_CONSTRAINTS = {
    edgeMargin: 12,
    gap: 10,
    maxHeight: 520,
    width: 420,
} as const;
const PANEL_THRESHOLDS = {
    minimumHeight: 560,
    minimumWidth: 768,
} as const;

export type SessionConfigPanelViewport = FloatingPanelViewport;
export type SessionConfigPanelMode = FloatingPanelMode;
export type SessionConfigPanelGeometry = FloatingPanelGeometry;
export type SessionConfigPanelPlacement = FloatingPanelPlacement;

export function sessionConfigPanelMode(viewport: SessionConfigPanelViewport): SessionConfigPanelMode {
    return floatingPanelMode(viewport, PANEL_THRESHOLDS);
}

export function placeSessionConfigPanel(geometry: SessionConfigPanelGeometry): SessionConfigPanelPlacement {
    return placeFloatingPanel(geometry, PANEL_CONSTRAINTS);
}
