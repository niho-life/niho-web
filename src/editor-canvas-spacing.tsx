"use client";

import { useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { uiColor } from "./ui-tokens.js";

const padding = [
  { property: "paddingTop", label: "上のパディング", x: .5, y: 0, axis: "y", direction: 1 },
  { property: "paddingRight", label: "右のパディング", x: 1, y: .5, axis: "x", direction: -1 },
  { property: "paddingBottom", label: "下のパディング", x: .5, y: 1, axis: "y", direction: -1 },
  { property: "paddingLeft", label: "左のパディング", x: 0, y: .5, axis: "x", direction: 1 },
] as const;
export type CanvasSpacingProperty = typeof padding[number]["property"] | "gap" | "rowGap" | "columnGap";
type Rect = { left: number; top: number; width: number; height: number };
type Drag = { property: CanvasSpacingProperty; pointer: number; position: number; initial: number; value: number; restore: () => void };

export const canvasSpacingCss = `
  .nw-spacing-handle{position:absolute;z-index:2147483001;width:18px;height:8px;transform:translate(-50%,-50%);border:1px solid ${uiColor.bg};border-radius:4px;padding:0;background:${uiColor.accent};box-shadow:0 0 0 1px ${uiColor.accentStrong};cursor:ns-resize;touch-action:none}
  .nw-spacing-handle[data-axis=x]{width:8px;height:18px;cursor:ew-resize}.nw-spacing-handle[data-gap=true]{background:${uiColor.bg};border-color:${uiColor.accent}}
  .nw-spacing-handle:hover,.nw-spacing-handle[data-dragging=true]{background:${uiColor.accentStrong}}.nw-spacing-value{position:absolute;left:12px;top:12px;white-space:nowrap;padding:2px 4px;border-radius:3px;color:${uiColor.bg};background:${uiColor.accentStrong};font:11px sans-serif;pointer-events:none}
`;

export function CanvasSpacingHandles({ element, rect, enabled, allowed, commit }: {
  element: HTMLElement; rect: Rect; enabled: boolean; allowed: (property: CanvasSpacingProperty) => boolean;
  commit: (property: CanvasSpacingProperty, value: number) => void;
}) {
  const active = useRef<Drag | null>(null);
  const [dragged, setDragged] = useState<{ property: CanvasSpacingProperty; value: number } | null>(null);
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  const gapAxis = computed?.display.includes("flex") && !computed.flexDirection.startsWith("column") ? "x" : "y";
  const gapValue = gapAxis === "x" ? computed?.columnGap : computed?.rowGap;
  const hasAxisGap = Number.isFinite(Number.parseFloat(gapValue ?? ""));
  const bothGaps = computed?.gap?.trim().split(/\s+/u) ?? [];
  const gapStart = hasAxisGap ? gapValue : bothGaps[gapAxis === "x" ? 1 : 0] ?? bothGaps[0];
  const gapUsesPercent = gapStart?.includes("%") ?? false;
  const draggedGap = dragged?.property && !dragged.property.startsWith("padding") ? dragged.property : undefined;
  const gapProperty = draggedGap ?? (bothGaps.length > 1 || hasAxisGap && gapValue !== computed?.gap ? (gapAxis === "x" ? "columnGap" : "rowGap") : "gap");
  const gap = { property: gapProperty, label: "子要素の間隔", x: gapAxis === "x" ? .25 : 1, y: gapAxis === "x" ? 1 : .25, axis: gapAxis, direction: 1 } as const;
  const handles = [...padding, ...(computed && /flex|grid/u.test(computed.display) && !gapUsesPercent ? [gap] : [])].filter(({ property }) => allowed(property));

  useLayoutEffect(() => () => {
    active.current?.restore();
    active.current = null;
  }, [element, enabled]);
  useLayoutEffect(() => {
    const drag = active.current;
    if (drag && !handles.some(({ property }) => property === drag.property)) end(drag.pointer, false);
  });

  function end(pointer: number, apply: boolean) {
    const drag = active.current;
    if (!drag || drag.pointer !== pointer) return;
    active.current = null;
    drag.restore();
    setDragged(null);
    if (apply && drag.value !== drag.initial && allowed(drag.property)) commit(drag.property, drag.value);
  }

  if (!enabled) return null;
  return handles.map(({ property, label, x, y, axis, direction }) => {
    const isGap = property === gap.property;
    const position = (event: PointerEvent<HTMLButtonElement>) => axis === "x" ? event.clientX : event.clientY;
    const move = (event: PointerEvent<HTMLButtonElement>) => {
      const drag = active.current;
      if (!drag || drag.pointer !== event.pointerId || drag.property !== property) return;
      const delta = Math.round((position(event) - drag.position) * direction);
      drag.value = delta === 0 ? drag.initial : Math.max(0, Math.min(10000, Math.round(drag.initial + delta)));
      element.style.setProperty(property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), `${drag.value}px`, "important");
      setDragged({ property, value: drag.value });
    };
    return <button key={property} type="button" className="nw-spacing-handle" tabIndex={-1} aria-label={`${label}をドラッグして変更`} title={`${label}をドラッグして変更`} data-spacing={property} data-axis={axis} data-gap={isGap} data-dragging={dragged?.property === property}
      style={{ left: rect.left + rect.width * x, top: rect.top + rect.height * y }}
      onPointerDown={(event) => {
        if (event.button !== 0 || active.current) return;
        event.preventDefault(); event.stopPropagation();
        const cssProperty = property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
        const previous = element.getAttribute("style");
        const initial = Number.parseFloat((isGap ? gapStart : computed?.[property]) ?? "") || 0;
        active.current = { property, pointer: event.pointerId, position: position(event), initial, value: initial,
          restore: () => {
            if (previous === null) element.removeAttribute("style");
            else element.setAttribute("style", previous);
          } };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        // shorthand がある場合もドラッグ中の値を優先して表示する。
        element.style.setProperty(cssProperty, `${initial}px`, "important");
        setDragged({ property, value: initial });
      }}
      onPointerMove={move} onPointerUp={(event) => { move(event); end(event.pointerId, true); }}
      onPointerCancel={(event) => end(event.pointerId, false)} onLostPointerCapture={(event) => end(event.pointerId, false)}>
      {dragged?.property === property && <span className="nw-spacing-value" aria-hidden="true">{dragged.value}px</span>}
    </button>;
  });
}
