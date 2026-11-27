"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { formatDateTime } from "./collection-ui.js";
import type { LocalizationItemState, LocalizationUnitState } from "./localization-workspace-model.js";

/* ---------- 状態の印（色だけに頼らず、形と言葉でも分かるように） ---------- */

/** Confirmation was removed. Current translations, missing translations and stale translations have distinct labels. */
type Shape = "untranslated" | "source-newer" | "reviewed" | "excluded";
const itemShape: Record<LocalizationItemState, Shape> = { untranslated: "untranslated", draft: "untranslated", "source-changed": "source-newer", reviewed: "reviewed", excluded: "excluded" };
const shapeText = (shape: Shape, sourceLabel: string, targetLabel: string): string => shape === "source-newer" ? `${sourceLabel}の方が新しい`
  : shape === "untranslated" ? "未翻訳" : shape === "reviewed" ? `${targetLabel === "English" ? "英語" : targetLabel}あり` : "対象外";
export function ItemStateBadge({ state, sourceLabel = "原文", targetLabel = "訳文" }: { state: LocalizationItemState; sourceLabel?: string; targetLabel?: string }) {
  const shape = itemShape[state];
  return <span className="cw-pill lw-pill" data-lw-state={shape} data-lw-item-state={state}><span className="lw-shape" aria-hidden="true" />{shapeText(shape, sourceLabel, targetLabel)}</span>;
}
const unitShape: Record<LocalizationUnitState, Shape> = { source: "excluded", missing: "untranslated", "review-needed": "source-newer", draft: "reviewed", reviewed: "reviewed" };
export function UnitStateBadge({ state, sourceLabel = "原文", targetLabel = "訳文" }: { state: LocalizationUnitState; sourceLabel?: string; targetLabel?: string }) {
  const shape = unitShape[state];
  return <span className="cw-pill lw-pill" data-lw-state={shape} data-lw-unit-state={state}><span className="lw-shape" aria-hidden="true" />{state === "source" ? "原文のまま" : shapeText(shape, sourceLabel, targetLabel)}</span>;
}

/* ---------- 公開の版の名前 ---------- */

type ReleaseLabel = { readonly label: string; readonly publishedAt: string };
/** 版の名前のあとに付ける公開の日時「（2026/10/1 10:00）」。名前に日時がもう入っているとき（既定の「2026/10/27 15:48 の公開」）は空にして、同じ日時を重ねない。 */
export function releaseTimeSuffix(release: ReleaseLabel, timeZone: string): string {
  const at = formatDateTime(release.publishedAt, timeZone);
  return release.label.includes(at) ? "" : `（${at}）`;
}
/** 版の名前と公開の日時。 */
export const releaseName = (release: ReleaseLabel, timeZone: string): string => release.label + releaseTimeSuffix(release, timeZone);

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
