"use client";

import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { EditorBreakpoint } from "./editor-types.js";

export type WorkspaceScale = "fit" | 0.25 | 0.5 | 0.75 | 1 | 1.5 | 2;

/** The shared three-column presentation shell. Hosts supply content through named slots. */
export function EditorWorkspace({ preview, leftOpen, rightOpen, chrome, left, canvas, right, dialogs, setBody }: {
  preview: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  chrome?: ReactNode;
  left: ReactNode;
  canvas: ReactNode;
  right: ReactNode;
  dialogs?: ReactNode;
  setBody?: (element: HTMLDivElement | null) => void;
}) {
  return <div className={`nw-editor${preview ? " is-preview" : ""}`}>
    {chrome}
    <div className={`e-body${leftOpen ? "" : " is-left-closed"}${rightOpen ? "" : " is-right-closed"}`} ref={setBody}>
      {left}{canvas}{right}
    </div>
    {dialogs}
  </div>;
}

type IconName = "back" | "close" | "desktop" | "laptop" | "tablet" | "mobile" | "undo" | "redo" | "history" | "preview" | "save" | "publish" | "leftPanel" | "rightPanel";

/** 左レールと上部の操作で同じ線の太さ（24 のマス目で 1.5）。大きさは CSS の .e-tool-icon / .e-action-icon が 18px にそろえる。 */
export function WorkspaceIcon({ name }: { name: IconName }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const paths: Record<IconName, ReactNode> = {
    back: <><path d="m14.5 5-7 7 7 7" /><path d="M8 12h11" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    desktop: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    laptop: <><rect x="4" y="4" width="16" height="12" rx="1" /><path d="M2 19h20l-2-3H4z" /></>,
    tablet: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M11 18h2" /></>,
    mobile: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>,
    undo: <><path d="M9 7 4 12l5 5" /><path d="M5 12h8a6 6 0 0 1 6 6" /></>,
    redo: <><path d="m15 7 5 5-5 5" /><path d="M19 12h-8a6 6 0 0 0-6 6" /></>,
    history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" /><path d="M4 4v4.6h4.6M12 8v4l3 2" /></>,
    preview: <path d="m8 5 11 7-11 7V5Z" />,
    save: <><path d="M5 3h12l2 2v16H5z" /><path d="M8 3v6h8V3M8 16h8" /></>,
    publish: <><path d="M12 3v12M7 8l5-5 5 5" /><path d="M5 13v8h14v-8" /></>,
    leftPanel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    rightPanel: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></>
  };
  return <svg className="e-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...common}>{paths[name]}</svg>;
}

export function PanelToggle({ side, open, onClick }: { side: "left" | "right"; open: boolean; onClick: () => void }) {
  const name = side === "left" ? "左パネル" : "右パネル";
  return <button type="button" className="e-panel-toggle" aria-label={`${name}を${open ? "閉じる" : "開く"}`} title={`${name}を${open ? "閉じる" : "開く"}`} aria-pressed={open} onClick={onClick}>
    <WorkspaceIcon name={side === "left" ? "leftPanel" : "rightPanel"} />
  </button>;
}

export type WorkspaceTab<T extends string> = { value: T; label: string };

export function InspectorTabs<T extends string>({ tabs, active, disabled, onChange }: {
  tabs: readonly WorkspaceTab<T>[];
  active: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const chooseByKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
    const next = tabs[nextIndex]; if (next) onChange(next.value);
  };
  return <div className="e-inspector-tabs" role="tablist" aria-label="要素の編集パネル">{tabs.map(({ value, label }, index) => <button key={value} type="button" role="tab" id={`e-inspector-tab-${value}`} aria-controls="e-inspector-panel" aria-selected={active === value} tabIndex={active === value ? 0 : -1} disabled={disabled}
    onClick={() => onChange(value)} onKeyDown={(event) => chooseByKey(event, index)}>{label}</button>)}</div>;
}

export function WorkspaceScaleSelect({ scale, fitPercent, onScale }: { scale: WorkspaceScale; fitPercent: number; onScale: (value: WorkspaceScale) => void }) {
  // 閉じた状態は STUDIO と同じ「50%」だけを出す。全体表示は「全体表示」のグループに入れ、一覧の中で固定の 50% と見分ける。
  return <label className="e-zoom-field"><span className="e-vh">表示倍率</span><select aria-label="表示倍率" title={scale === "fit" ? `全体表示（作業領域に収まる倍率: ${fitPercent}%）` : "表示倍率"} value={String(scale)} onChange={(event) => onScale(event.target.value === "fit" ? "fit" : Number(event.target.value) as WorkspaceScale)}>
    <optgroup label="全体表示"><option value="fit">{fitPercent}%</option></optgroup>
    <optgroup label="倍率"><option value="0.25">25%</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></optgroup>
  </select></label>;
}

export type ViewportPreset = { width: number; start: number; label: string; icon: "desktop" | "laptop" | "tablet" | "mobile" };

/** Resize the centered canvas from either edge without changing the document's styles. */
export function ViewportEdgeHandle({ side, width, scale, disabled, onWidthChange }: {
  side: "left" | "right"; width: number; scale: number; disabled: boolean; onWidthChange: (width: number) => void;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number; scale: number } | null>(null);
  const clamp = (value: number) => Math.max(320, Math.min(1920, Math.round(value)));
  const stop = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <button type="button" className={`e-viewport-edge is-${side}`} aria-label={`画面${side === "left" ? "左" : "右"}端で表示幅を変更`} title="ドラッグ、または左右キーで表示幅を変更" disabled={disabled}
    onPointerDown={(event) => { if (disabled || event.button !== 0) return; drag.current = { pointerId: event.pointerId, x: event.clientX, width, scale: Math.max(scale, .01) }; event.currentTarget.setPointerCapture?.(event.pointerId); event.preventDefault(); }}
    onPointerMove={(event) => { const active = drag.current; if (!active || active.pointerId !== event.pointerId) return; onWidthChange(clamp(active.width + (event.clientX - active.x) * (side === "right" ? 2 : -2) / active.scale)); }}
    onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={(event) => { const step = event.shiftKey ? 10 : 1; const delta = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
      if (delta || event.key === "Home" || event.key === "End") { event.preventDefault(); onWidthChange(event.key === "Home" ? 320 : event.key === "End" ? 1920 : clamp(width + delta)); }
    }} />;
}

/** Site breakpoints determine the selectable widths; the mobile-first base gets its own preview. */
export function viewportPresets(breakpoints: readonly EditorBreakpoint[], mobilePreviewWidth = 375): ViewportPreset[] {
  const usable = breakpoints.filter((entry) => entry.minWidth <= 1920);
  const first = breakpoints[0]?.minWidth ?? 1921;
  const base = Number.isInteger(mobilePreviewWidth) && mobilePreviewWidth >= 320 && mobilePreviewWidth <= 1920 && mobilePreviewWidth < first
    ? mobilePreviewWidth : Math.min(375, first - 1);
  const icon = (width: number): ViewportPreset["icon"] => width >= 1100 ? "desktop" : width >= 900 ? "laptop" : width >= 600 ? "tablet" : "mobile";
  return [...usable].reverse().map((entry) => ({ width: entry.previewWidth ?? entry.minWidth, start: entry.minWidth, label: entry.label, icon: icon(entry.minWidth) }))
    .concat(base >= 320 ? [{ width: base, start: 0, label: "モバイル", icon: "mobile" }] : []);
}

export function CanvasViewportToolbar({ width, widthField, leftOpen, rightOpen, disabled, presets = viewportPresets([{ minWidth: 768, label: "タブレット" }, { minWidth: 1280, label: "PC" }]), onWidthInput, onWidthCommit, toggleLeft, toggleRight, children }: {
  width: number;
  widthField: string;
  leftOpen: boolean;
  rightOpen: boolean;
  disabled?: boolean;
  presets?: readonly ViewportPreset[];
  onWidthInput: (value: string) => void;
  onWidthCommit: () => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  children?: ReactNode;
}) {
  const preset = ({ width: value, start, icon, label }: ViewportPreset, index: number) => <button key={`${start}-${value}`} type="button" className="e-device-button" aria-label={`${label} ${value}px`} title={`${label} ${value}px`} aria-pressed={width >= start && (index === 0 || width < presets[index - 1]!.start)} disabled={disabled}
    onClick={() => { onWidthInput(String(value)); }}><WorkspaceIcon name={icon} /></button>;
  return <div className="e-canvas-tools" role="toolbar" aria-label="キャンバス表示">
    {!leftOpen && <PanelToggle side="left" open={false} onClick={toggleLeft} />}
    <label className="e-width-field"><span className="e-vh">表示幅</span><input aria-label="表示幅" type="number" min={320} max={1920} step={1} value={widthField} disabled={disabled} onChange={(event) => onWidthInput(event.target.value)} onBlur={onWidthCommit} /><span>px</span></label>
    <div className="e-device-group" role="group" aria-label="デバイス幅">{presets.map(preset)}</div>
    {children}
    {!rightOpen && <PanelToggle side="right" open={false} onClick={toggleRight} />}
  </div>;
}
