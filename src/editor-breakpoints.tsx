"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "./editor-dialog.js";
import type { EditorAdapter, EditorBreakpointName, EditorBreakpointSettings } from "./editor-types.js";
import { addBreakpointSetting, breakpointLabels, breakpointSettingsBreakpoints, breakpointUsageCount, parseBreakpointSettings, removeBreakpointSetting } from "./style-model.js";
import type { PageDocument } from "./types.js";

type Loaded = { siteId: string; settings: EditorBreakpointSettings; version: string };
const loadedSnapshot = (siteId: string, settings: unknown, version: unknown): Loaded => {
  if (typeof version !== "string" || !version || version.length > 512 || /[\u0000-\u001f\u007f]/u.test(version)) throw new Error("ブレークポイント設定の版が正しくありません。");
  return { siteId, settings: parseBreakpointSettings(settings), version };
};
export type BreakpointSettingsState = {
  status: "loading" | "ready" | "error";
  settings: EditorBreakpointSettings;
  editable: boolean;
  busy: boolean;
  conflict: boolean;
  message: string | null;
  reload(): void;
  save(settings: EditorBreakpointSettings): Promise<boolean>;
};

export function useBreakpointSettings(adapter: EditorAdapter, siteId: string, fallback: EditorBreakpointSettings): BreakpointSettingsState {
  const connected = adapter.breakpointSettings;
  const siteIdRef = useRef(siteId); siteIdRef.current = siteId;
  const [loaded, setLoaded] = useState<Loaded | null>(null), [status, setStatus] = useState<"loading" | "ready" | "error">(connected ? "loading" : "ready");
  const [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [message, setMessage] = useState<string | null>(null), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    setLoaded(null); setConflict(false); setMessage(null); setBusy(false);
    if (!connected || !siteId) { setStatus("ready"); return; }
    const controller = new AbortController(); setStatus("loading");
    void connected.read(siteId, controller.signal).then((snapshot) => {
      if (!controller.signal.aborted && siteIdRef.current === siteId) { setLoaded(loadedSnapshot(siteId, snapshot.settings, snapshot.version)); setStatus("ready"); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && siteIdRef.current === siteId) { setStatus("error"); setMessage(error instanceof Error ? error.message : "ブレークポイント設定を読み込めませんでした。"); }
    });
    return () => controller.abort();
  }, [adapter, connected, siteId, epoch]);
  const activeLoaded = loaded?.siteId === siteId ? loaded : null;
  const settings = activeLoaded?.settings ?? fallback;
  return {
    status, settings, editable: !!connected && status === "ready" && !!activeLoaded, busy, conflict, message,
    reload: () => setEpoch((value) => value + 1),
    save: async (next) => {
      if (!connected || !siteId || !activeLoaded || busy) return false;
      const savingSiteId = siteId, current = () => siteIdRef.current === savingSiteId;
      let parsed: EditorBreakpointSettings;
      try { parsed = parseBreakpointSettings(next); }
      catch (error) { setMessage(error instanceof Error ? error.message : "ブレークポイント設定が正しくありません。"); return false; }
      const controller = new AbortController(); setBusy(true); setConflict(false); setMessage(null);
      let persisted = false;
      try {
        const saved = await connected.save({ siteId: savingSiteId, settings: parsed, expectedVersion: activeLoaded.version }, controller.signal);
        if (!current()) return false;
        if (saved.status === "conflict") { setConflict(true); setMessage("別の画面で設定が更新されました。最新の設定を再読み込みしてください。"); return false; }
        if (saved.status !== "saved") throw new Error("ブレークポイント設定の保存結果が正しくありません。");
        persisted = true;
        const fresh = await connected.read(savingSiteId, controller.signal);
        if (!current()) return false;
        setLoaded(loadedSnapshot(savingSiteId, fresh.settings, fresh.version)); setStatus("ready");
        return true;
      } catch (error) {
        if (current()) {
          if (persisted) { setConflict(true); setMessage("設定は保存されましたが、保存後の再読み込みに失敗しました。最新の設定を再読み込みしてください。"); }
          else setMessage(error instanceof Error ? error.message : "ブレークポイント設定を保存できませんでした。");
        }
        return false;
      } finally { if (current()) setBusy(false); }
    }
  };
}

const order: readonly EditorBreakpointName[] = ["Mini", "Mobile", "Tablet", "Small", "PC"];

function changedWidths(before: EditorBreakpointSettings, after: EditorBreakpointSettings): { name: EditorBreakpointName; before: number; after: string }[] {
  const next = new Map(after.breakpoints.map((entry) => [entry.name, entry.minWidth]));
  return before.breakpoints.filter((entry) => next.get(entry.name) !== entry.minWidth).map((entry) => ({
    name: entry.name, before: entry.minWidth,
    after: next.has(entry.name) ? `${next.get(entry.name)}px` : after.base.name === entry.name ? "基本段" : "削除"
  }));
}

export function BreakpointSettingsDialog({ state, document, saveBlockedReason, close }: {
  state: BreakpointSettingsState;
  document?: PageDocument;
  saveBlockedReason?: string;
  close(): void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(state.settings)), [addName, setAddName] = useState<EditorBreakpointName | "">(""), [confirmed, setConfirmed] = useState(false), [operationMessage, setOperationMessage] = useState("");
  useEffect(() => { setDraft(structuredClone(state.settings)); setConfirmed(false); setOperationMessage(""); }, [state.settings]);
  const available = order.filter((name) => name !== draft.base.name && !draft.breakpoints.some((entry) => entry.name === name));
  const affectedWidths = changedWidths(state.settings, draft), affectedCount = document ? affectedWidths.reduce((sum, value) => sum + breakpointUsageCount(document, value.before), 0) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  let validation = "";
  try { parseBreakpointSettings(draft); } catch (error) { validation = error instanceof Error ? error.message : "設定を確認してください。"; }
  const updateEntry = (name: EditorBreakpointName, patch: { minWidth?: number; previewWidth?: number }) => { setOperationMessage(""); setDraft((current) => ({ ...current, breakpoints: current.breakpoints.map((entry) => entry.name === name ? { ...entry, ...patch } : entry) })); };
  const add = () => {
    if (!addName) return;
    try {
      setDraft(addBreakpointSetting(draft, addName));
      setAddName(""); setConfirmed(false); setOperationMessage("");
    } catch (error) { setOperationMessage(error instanceof Error ? error.message : "段を追加できませんでした。"); }
  };
  const remove = (name: EditorBreakpointName) => {
    try { setDraft(removeBreakpointSetting(draft, name)); setConfirmed(false); setOperationMessage(""); }
    catch (error) { setOperationMessage(error instanceof Error ? error.message : "段を削除できませんでした。"); }
  };
  const disabled = !state.editable || state.busy || state.conflict;
  return <Dialog name="編集モード" dismiss={close}>
    <div className="e-breakpoint-head"><div><h2>編集モード</h2><p>サイト全体のブレークポイントとプレビュー幅</p></div><button type="button" aria-label="編集モードを閉じる" autoFocus onClick={close}>閉じる</button></div>
    {state.status === "loading" && <p role="status">設定を読み込んでいます…</p>}
    {state.status === "error" && <div className="e-breakpoint-conflict" role="alert"><p>{state.message ?? "設定を読み込めませんでした。"}</p><button type="button" onClick={state.reload}>設定を再試行</button></div>}
    {!state.editable && state.status === "ready" && <p className="e-help">このホストはサイト単位の保存に接続していないため、現在の値を読み取り専用で表示します。</p>}
    <div className="e-breakpoint-table" role="group" aria-label="ブレークポイントの段">
      <div className="e-breakpoint-row"><strong>{breakpointLabels[draft.base.name]}</strong><label><span>開始幅</span><input aria-label={`${breakpointLabels[draft.base.name]}の開始幅`} type="number" value={320} disabled /></label><label><span>プレビュー幅</span><input aria-label={`${breakpointLabels[draft.base.name]}のプレビュー幅`} type="number" min={320} max={1920} value={draft.base.previewWidth} disabled={disabled} onChange={(event) => { setOperationMessage(""); setDraft((current) => ({ ...current, base: { ...current.base, previewWidth: Number(event.target.value) } })); setConfirmed(false); }} /></label>{draft.base.name === "PC" ? <span className="e-breakpoint-required">必須</span> : <button type="button" disabled={disabled} onClick={() => remove(draft.base.name)}>削除</button>}</div>
      {draft.breakpoints.map((entry) => <div className="e-breakpoint-row" key={entry.name}><strong>{breakpointLabels[entry.name]}</strong><label><span>開始幅</span><input aria-label={`${breakpointLabels[entry.name]}の開始幅`} type="number" min={320} max={1920} value={entry.minWidth} disabled={disabled} onChange={(event) => { updateEntry(entry.name, { minWidth: Number(event.target.value) }); setConfirmed(false); }} /></label><label><span>プレビュー幅</span><input aria-label={`${breakpointLabels[entry.name]}のプレビュー幅`} type="number" min={320} max={1920} value={entry.previewWidth} disabled={disabled} onChange={(event) => { updateEntry(entry.name, { previewWidth: Number(event.target.value) }); setConfirmed(false); }} /></label>{entry.name === "PC" ? <span className="e-breakpoint-required">必須</span> : <button type="button" disabled={disabled} onClick={() => remove(entry.name)}>削除</button>}</div>)}
    </div>
    {available.length > 0 && <div className="e-breakpoint-add"><label><span className="e-vh">追加する段</span><select aria-label="追加する段" value={addName} disabled={disabled} onChange={(event) => setAddName(event.target.value as EditorBreakpointName | "")}><option value="">段を選択</option>{available.map((name) => <option key={name} value={name}>{breakpointLabels[name]}</option>)}</select></label><button type="button" disabled={disabled || !addName} onClick={add}>段を追加</button></div>}
    {(operationMessage || validation) && <p className="e-problem" role="alert">{operationMessage || validation}</p>}
    {affectedWidths.length > 0 && <div className="e-breakpoint-impact" role="note"><strong>既存の幅指定は残ります</strong><ul>{affectedWidths.map((entry) => <li key={entry.name}>{breakpointLabels[entry.name]}: {entry.before}px → {entry.after}</li>)}</ul><p>上記の開始幅は現在のページに {affectedCount === null ? "確認できない件数" : `${affectedCount}件`} あります。設定を保存しても文書内の指定は移行・削除されず、ほかの全ページと共通内容にも影響し得ます。</p><label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => setConfirmed(event.target.checked)} /> 内容を確認しました</label></div>}
    {saveBlockedReason && <p className="e-help e-problem">{saveBlockedReason}</p>}
    {state.conflict && <div className="e-breakpoint-conflict" role="alert"><p>{state.message}</p><button type="button" onClick={state.reload}>編集中の変更を破棄して再読み込み</button></div>}
    {!state.conflict && state.message && state.status !== "error" && <p className="e-problem" role="alert">{state.message}</p>}
    <div className="e-dialog-actions"><button type="button" onClick={close}>閉じる</button><button type="button" className="e-primary" disabled={disabled || !dirty || !!validation || !!operationMessage || !!saveBlockedReason || affectedWidths.length > 0 && !confirmed} onClick={() => void state.save(parseBreakpointSettings(draft))}>{state.busy ? "保存中…" : "サイト設定を保存"}</button></div>
  </Dialog>;
}

export const breakpointPreview = (settings: EditorBreakpointSettings) => ({ breakpoints: breakpointSettingsBreakpoints(settings), basePreviewWidth: settings.base.previewWidth, baseLabel: breakpointLabels[settings.base.name] });
