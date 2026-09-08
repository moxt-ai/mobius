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
    width: 440,
} as const;
const PANEL_THRESHOLDS = {
    minimumHeight: 560,
    minimumWidth: 768,
} as const;

export type WorkspacePickerPanelViewport = FloatingPanelViewport;
export type WorkspacePickerPanelMode = FloatingPanelMode;
export type WorkspacePickerPanelGeometry = FloatingPanelGeometry;
export type WorkspacePickerPanelPlacement = FloatingPanelPlacement;

export function workspacePickerPanelMode(viewport: WorkspacePickerPanelViewport): WorkspacePickerPanelMode {
    return floatingPanelMode(viewport, PANEL_THRESHOLDS);
}

export function placeWorkspacePickerPanel(geometry: WorkspacePickerPanelGeometry): WorkspacePickerPanelPlacement {
    return placeFloatingPanel(geometry, PANEL_CONSTRAINTS);
}
