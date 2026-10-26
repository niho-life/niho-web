"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import type { LocalizationItemState, LocalizationUnitState } from "./localization-workspace-model.js";

/* ---------- 状態の印（色だけに頼らず、形と言葉でも分かるように） ---------- */

const itemText: Record<LocalizationItemState, string> = { untranslated: "未翻訳", draft: "下書き", "source-changed": "原文が更新", reviewed: "確認済み", excluded: "対象外" };
export function ItemStateBadge({ state }: { state: LocalizationItemState }) {
  return <span className="cw-pill lw-pill" data-lw-state={state}><span className="lw-shape" aria-hidden="true" />{itemText[state]}</span>;
}
const unitText: Record<LocalizationUnitState, string> = { source: "原文のまま", missing: "未翻訳", draft: "未確認", "review-needed": "原文が更新", reviewed: "確認済み" };
const unitShape: Record<LocalizationUnitState, LocalizationItemState> = { source: "excluded", missing: "untranslated", draft: "draft", "review-needed": "source-changed", reviewed: "reviewed" };
export function UnitStateBadge({ state }: { state: LocalizationUnitState }) {
  return <span className="cw-pill lw-pill" data-lw-state={unitShape[state]} data-lw-unit-state={state}><span className="lw-shape" aria-hidden="true" />{unitText[state]}</span>;
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
