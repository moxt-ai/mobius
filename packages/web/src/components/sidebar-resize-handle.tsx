import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef } from "react";

import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/services/workspace-layout";

interface DragState {
    readonly pointerId: number;
    readonly startWidth: number;
    readonly startX: number;
}

interface SidebarResizeHandleProps {
    readonly onResize: (width: number) => void;
    readonly onResizeEnd: (width: number, previousWidth: number) => void;
    readonly onReset: () => void;
    readonly width: number;
}

const KEYBOARD_RESIZE_STEP = 8;

export function SidebarResizeHandle({ onResize, onResizeEnd, onReset, width }: SidebarResizeHandleProps) {
    const dragRef = useRef<DragState | null>(null);
    const latestWidthRef = useRef(width);
    const previousCursorRef = useRef("");
    const previousUserSelectRef = useRef("");

    const restoreDocumentInteraction = (): void => {
        document.body.style.cursor = previousCursorRef.current;
        document.body.style.userSelect = previousUserSelectRef.current;
    };

    useEffect(
        () => () => {
            document.body.style.cursor = previousCursorRef.current;
            document.body.style.userSelect = previousUserSelectRef.current;
        },
        [],
    );

    const beginResize = (event: ReactPointerEvent<HTMLHRElement>): void => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        latestWidthRef.current = width;
        dragRef.current = {
            pointerId: event.pointerId,
            startWidth: width,
            startX: event.clientX,
        };
        previousCursorRef.current = document.body.style.cursor;
        previousUserSelectRef.current = document.body.style.userSelect;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const continueResize = (event: ReactPointerEvent<HTMLHRElement>): void => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) {
            return;
        }
        const requestedWidth = drag.startWidth + event.clientX - drag.startX;
        latestWidthRef.current = requestedWidth;
        onResize(requestedWidth);
    };

    const finishResize = (event: ReactPointerEvent<HTMLHRElement>): void => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) {
            return;
        }
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        restoreDocumentInteraction();
        onResizeEnd(latestWidthRef.current, drag.startWidth);
    };

    return (
        <hr
            aria-label="Resize conversation sidebar"
            aria-orientation="vertical"
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuenow={width}
            className="absolute inset-y-0 -right-1.5 z-40 hidden h-auto w-3 cursor-col-resize touch-none border-0 bg-transparent outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors after:duration-150 motion-reduce:after:transition-none hover:after:bg-primary focus-visible:after:bg-primary lg:block"
            onDoubleClick={onReset}
            onKeyDown={(event) => {
                const step = event.shiftKey ? KEYBOARD_RESIZE_STEP * 3 : KEYBOARD_RESIZE_STEP;
                if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    onResizeEnd(width - step, width);
                } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    onResizeEnd(width + step, width);
                } else if (event.key === "Home") {
                    event.preventDefault();
                    onResizeEnd(MIN_SIDEBAR_WIDTH, width);
                } else if (event.key === "End") {
                    event.preventDefault();
                    onResizeEnd(MAX_SIDEBAR_WIDTH, width);
                } else if (event.key === "Enter") {
                    event.preventDefault();
                    onResizeEnd(DEFAULT_SIDEBAR_WIDTH, width);
                }
            }}
            onPointerCancel={finishResize}
            onPointerDown={beginResize}
            onPointerMove={continueResize}
            onPointerUp={finishResize}
            tabIndex={0}
            title="Drag to resize. Double-click or press Enter to reset."
        />
    );
}
