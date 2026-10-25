"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { CollectionIcon, CollectionItemStatus } from "./collection-model.js";

/* ---------- 非同期の読み書き（閉じた・差し替えた後の応答を捨てる） ---------- */

export type Outcome<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "error"; readonly error: unknown } | { readonly kind: "aborted" };
/** 画面ごとに 1 つ持つ。close したら進行中の signal を abort し、abort を無視した adapter の遅い応答も捨てる。 */
export class Requests {
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  async run<T>(call: (signal: AbortSignal) => Promise<T>): Promise<Outcome<T>> {
    if (this.closed) return { kind: "aborted" };
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      const value = await Promise.resolve().then(() => call(controller.signal));
      return controller.signal.aborted || this.closed ? { kind: "aborted" } : { kind: "ok", value };
    } catch (error) {
      return controller.signal.aborted || this.closed ? { kind: "aborted" } : { kind: "error", error };
    } finally {
      this.controllers.delete(controller);
    }
  }
  get isClosed() { return this.closed; }
  close() {
    this.closed = true;
    this.controllers.forEach((controller) => controller.abort());
    this.controllers.clear();
  }
}
/** mount 中だけ使える Requests。StrictMode の付け外しでも閉じた後の応答は捨てる。 */
export function useRequests() {
  const ref = useRef<Requests>(new Requests());
  useEffect(() => {
    if (ref.current.isClosed) ref.current = new Requests();
    const current = ref.current;
    return () => current.close();
  }, []);
  return ref;
}

/* ---------- 日時 ---------- */

export const zoneLabel = (timeZone: string) => timeZone === "Asia/Tokyo" ? "日本時間" : timeZone;
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
export function formatShort(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone, month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
export function DateTime({ value, timeZone, empty = "—" }: { value: string | null; timeZone: string; empty?: string }) {
  return value === null ? <>{empty}</> : <time dateTime={value}>{formatDateTime(value, timeZone)}</time>;
}

/* ---------- アイコン（飾り。意味は必ず文字でも出す） ---------- */

const paths: Record<string, ReactNode> = {
  document: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></>,
  people: <><circle cx="9" cy="9" r="3" /><circle cx="16.5" cy="10" r="2.5" /><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M14.5 15.2c2.8-.6 5 .7 6 3.8" /></>,
  person: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5" /></>,
  tag: <><path d="M3.5 12.5V4h8.5l8.5 8.5-8.5 8.5z" /><circle cx="8" cy="8.5" r="1.3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <><circle cx="5.5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18.5" cy="12" r="1.2" /></>,
  image: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  alert: <><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4.5M12 17v.3" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  back: <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />,
};
export function Icon({ name }: { name: CollectionIcon | keyof typeof paths }) {
  return <svg className="cw-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

/* ---------- 状態の印（色だけに頼らず、形と言葉でも分かるように） ---------- */

const statusText: Record<Exclude<CollectionItemStatus, "scheduled">, string> = { draft: "下書き", published: "公開中", changed: "変更あり", publishing: "反映中" };
export function StatusBadges({ status, scheduledAt, publishFailed, timeZone }: { status: CollectionItemStatus; scheduledAt: string | null; publishFailed: boolean; timeZone: string }) {
  return <span className="cw-badges">
    {status === "scheduled" && scheduledAt !== null
      ? <span className="cw-pill" data-status="scheduled"><span className="cw-dot" aria-hidden="true" />予約 {formatShort(scheduledAt, timeZone)}</span>
      : <span className="cw-pill" data-status={status}>{status === "publishing" ? <span className="cw-spin" aria-hidden="true" /> : <span className="cw-dot" aria-hidden="true" />}{statusText[status as keyof typeof statusText]}</span>}
    {status !== "scheduled" && scheduledAt !== null && <span className="cw-pill" data-status="scheduled"><span className="cw-dot" aria-hidden="true" />予約 {formatShort(scheduledAt, timeZone)}</span>}
    {publishFailed && <span className="cw-pill" data-status="failed"><Icon name="alert" />前回の公開に失敗</span>}
  </span>;
}

/* ---------- 「…」のメニュー ---------- */

export type MenuItem = { readonly label: string; readonly onSelect: () => void; readonly danger?: boolean };
export function MenuButton({ label, items, className }: { label: string; items: readonly MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !button.current?.contains(target) && !menu.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("touchstart", close); };
  }, [open]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); button.current?.focus(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); buttons[(index + 1) % buttons.length]?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); buttons[(index - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (event.key === "Home") { event.preventDefault(); buttons[0]?.focus(); }
    else if (event.key === "End") { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (event.key === "Tab") setOpen(false);
  };
  if (!items.length) return null;
  return <span className={`cw-menu-wrap${className ? ` ${className}` : ""}`}>
    <button ref={button} type="button" className="cw-icon-button" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}><Icon name="more" /></button>
    {open && <div ref={menu} id={id} className="cw-menu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => <button key={item.label} type="button" role="menuitem" className={item.danger ? "cw-danger-text" : undefined} onClick={() => { setOpen(false); button.current?.focus(); item.onSelect(); }}>{item.label}</button>)}
    </div>}
  </span>;
}

/* ---------- 確認のダイアログ ---------- */

export type ConfirmRequest = { readonly title: string; readonly body: string; readonly confirmLabel: string; readonly tone: "danger" | "primary"; readonly run: () => Promise<void> | void };
/** キーボードで操作でき、Tab は中で回る。閉じると開く前の場所へ focus を戻す。 */
export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const root = useRef<HTMLElement>(null), id = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try { await request.run(); } finally { onClose(); }
  };
  return <div className="cw-backdrop"><section ref={root} className="cw-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} aria-busy={busy} onKeyDown={(event) => {
    if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
    const first = controls[0], last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <h2 id={`${id}-title`}>{request.title}</h2>
    <p id={`${id}-body`}>{request.body}</p>
    <div className="cw-dialog-actions">
      <button type="button" className="cw-button" disabled={busy} onClick={onClose}>やめる</button>
      <button type="button" className={request.tone === "danger" ? "cw-button cw-danger" : "cw-button cw-primary"} disabled={busy} onClick={() => void confirm()}>{busy ? "処理しています…" : request.confirmLabel}</button>
    </div>
  </section></div>;
}
