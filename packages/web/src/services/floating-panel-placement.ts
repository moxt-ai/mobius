export interface FloatingPanelViewport {
    readonly viewportHeight: number;
    readonly viewportWidth: number;
}

export interface FloatingPanelThresholds {
    readonly minimumHeight: number;
    readonly minimumWidth: number;
}

export type FloatingPanelMode = "floating" | "sheet";

export interface FloatingPanelGeometry extends FloatingPanelViewport {
    readonly anchorBottom: number;
    readonly anchorLeft: number;
    readonly anchorTop: number;
}

export interface FloatingPanelConstraints {
    readonly edgeMargin: number;
    readonly gap: number;
    readonly maxHeight: number;
    readonly width: number;
}

export type FloatingPanelPlacement =
    | {
          readonly bottom: number;
          readonly kind: "above";
          readonly left: number;
          readonly maxHeight: number;
          readonly width: number;
      }
    | {
          readonly kind: "below";
          readonly left: number;
          readonly maxHeight: number;
          readonly top: number;
          readonly width: number;
      };

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

export function floatingPanelMode(
    viewport: FloatingPanelViewport,
    thresholds: FloatingPanelThresholds,
): FloatingPanelMode {
    return viewport.viewportWidth >= thresholds.minimumWidth && viewport.viewportHeight >= thresholds.minimumHeight
        ? "floating"
        : "sheet";
}

export function placeFloatingPanel(
    geometry: FloatingPanelGeometry,
    constraints: FloatingPanelConstraints,
): FloatingPanelPlacement {
    const width = Math.min(constraints.width, Math.max(0, geometry.viewportWidth - constraints.edgeMargin * 2));
    const left = clamp(
        geometry.anchorLeft,
        constraints.edgeMargin,
        Math.max(constraints.edgeMargin, geometry.viewportWidth - width - constraints.edgeMargin),
    );
    const spaceAbove = Math.max(0, geometry.anchorTop - constraints.gap - constraints.edgeMargin);
    const spaceBelow = Math.max(
        0,
        geometry.viewportHeight - geometry.anchorBottom - constraints.gap - constraints.edgeMargin,
    );

    if (spaceBelow > spaceAbove) {
        return {
            kind: "below",
            left,
            maxHeight: Math.min(constraints.maxHeight, spaceBelow),
            top: geometry.anchorBottom + constraints.gap,
            width,
        };
    }

    return {
        bottom: geometry.viewportHeight - geometry.anchorTop + constraints.gap,
        kind: "above",
        left,
        maxHeight: Math.min(constraints.maxHeight, spaceAbove),
        width,
    };
}
