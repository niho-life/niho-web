"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { LocalizationItemState, LocalizationUnitState } from "./localization-workspace-model.js";

/* ---------- 状態の印（色だけに頼らず、形と言葉でも分かるように） ---------- */

/**
 * 確認の工程は廃止（2026-11-12）。今の原文に対応する訳があれば「翻訳済み」、無ければ（原文が変わって古くなった訳を含む）「未翻訳」。
 * 印（data-lw-state）は表示に合わせた 3 種（untranslated・reviewed・excluded）にし、届いた状態の値は data-lw-item-state / data-lw-unit-state に残す。
 */
type Shape = "untranslated" | "reviewed" | "excluded";
const itemShape: Record<LocalizationItemState, Shape> = { untranslated: "untranslated", draft: "untranslated", "source-changed": "untranslated", reviewed: "reviewed", excluded: "excluded" };
const shapeText: Record<Shape, string> = { untranslated: "未翻訳", reviewed: "翻訳済み", excluded: "対象外" };
export function ItemStateBadge({ state }: { state: LocalizationItemState }) {
  const shape = itemShape[state];
  return <span className="cw-pill lw-pill" data-lw-state={shape} data-lw-item-state={state}><span className="lw-shape" aria-hidden="true" />{shapeText[shape]}</span>;
}
const unitShape: Record<LocalizationUnitState, Shape> = { source: "excluded", missing: "untranslated", "review-needed": "untranslated", draft: "reviewed", reviewed: "reviewed" };
export function UnitStateBadge({ state }: { state: LocalizationUnitState }) {
  const shape = unitShape[state];
  return <span className="cw-pill lw-pill" data-lw-state={shape} data-lw-unit-state={state}><span className="lw-shape" aria-hidden="true" />{state === "source" ? "原文のまま" : shapeText[shape]}</span>;
}

/* ---------- 進み具合（n/m） ---------- */

export function Progress({ label, done, total }: { label: string; done: number; total: number }) {
  return <span className="lw-progress"><span>{label} <span className="lw-num">{done}/{total}</span></span>
    <progress max={Math.max(total, 1)} value={Math.min(done, Math.max(total, 1))} aria-label={`${label}（${total} のうち ${done}）`} /></span>;
}

/* ---------- ダイアログ（キーボードで操作でき、Tab は中で回る。閉じると開く前の場所へ focus を戻す） ---------- */

const FOCUSABLE = "button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])";
export function WorkspaceDialog({ title, onClose, children, wide = false, describedBy }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; describedBy?: string }) {
  const root = useRef<HTMLElement>(null), id = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const first = root.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root.current?.querySelector<HTMLElement>("h2"))?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="cw-backdrop"><section ref={root} className={`cw-dialog lw-dialog${wide ? " lw-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={describedBy}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <h2 id={`${id}-title`} tabIndex={-1}>{title}</h2>
    {children}
  </section></div>;
}

/** 中断できる待ち。closed() が true になったら false を返す。 */
export async function pause(ms: number, closed: () => boolean): Promise<boolean> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !closed();
}
