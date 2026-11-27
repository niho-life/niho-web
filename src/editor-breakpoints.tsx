"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "./editor-dialog.js";
import { parsePageDocument } from "./document.js";
import { parseSitePresentation } from "./presentation.js";
import { analyzeNormalization } from "./normalize.js";
import type { NormalizationAnalysis, NormalizationDocument } from "./normalize.js";
import type { ComponentLibrary, PageDocument, SitePresentation } from "./types.js";
import type { EditorAdapter, EditorBlockRegistry, EditorBreakpointName, EditorBreakpointSettings, EditorPage, EditorTarget } from "./editor-types.js";
import type { SiteStyles } from "./site-styles.js";
import { addBreakpointSetting, breakpointLabels, breakpointSettingsBreakpoints, breakpointUsageCount, parseBreakpointSettings, removeBreakpointSetting } from "./style-model.js";

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

type BreakpointAnalysisState =
  | { status: "waiting" | "loading"; completed: number; total: number }
  | { status: "error"; message: string }
  | { status: "ready"; analysis: NormalizationAnalysis; documentCount: number };

function targetKey(target: EditorTarget): string { return JSON.stringify([target.siteId, target.pageId, target.locale]); }

function useBreakpointAnalysis({
  adapter, pages, target, document, presentation, siteStyles, siteStylesReady, siteStylesFailed, components, componentsReady, componentsFailed, blocks, settings, settingsStatus,
}: {
  adapter: EditorAdapter;
  pages: readonly EditorPage[];
  target?: EditorTarget;
  document?: PageDocument;
  presentation?: SitePresentation;
  siteStyles: SiteStyles;
  siteStylesReady: boolean;
  siteStylesFailed: boolean;
  components?: ComponentLibrary;
  componentsReady: boolean;
  componentsFailed: boolean;
  blocks: EditorBlockRegistry;
  settings: EditorBreakpointSettings;
  settingsStatus: BreakpointSettingsState["status"];
}): { state: BreakpointAnalysisState; retry(): void } {
  const [state, setState] = useState<BreakpointAnalysisState>({ status: "waiting", completed: 0, total: 0 });
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const siteId = target?.siteId ?? pages[0]?.siteId;
    const sitePages = siteId ? pages.filter((page) => page.siteId === siteId) : [];
    if (settingsStatus === "error") { setState({ status: "error", message: "ブレークポイント設定を読み込めないため、全ページの分析ができません。設定を再試行してください。" }); return () => controller.abort(); }
    if (!siteId || sitePages.length === 0) { setState({ status: "error", message: "ページ一覧が空のため、全ページの分析ができません。ページ一覧を再読み込みしてください。" }); return () => controller.abort(); }
    if (siteStylesFailed) { setState({ status: "error", message: "共通スタイルを読み込めないため、全ページの分析ができません。サイト設定を再読み込みしてください。" }); return () => controller.abort(); }
    if (componentsFailed) { setState({ status: "error", message: "共通部品を読み込めないため、全ページの分析ができません。部品一覧を再読み込みしてください。" }); return () => controller.abort(); }
    if (settingsStatus === "loading" || adapter.readSiteSettings && !siteStylesReady || adapter.components && !componentsReady) {
      setState({ status: "waiting", completed: 0, total: sitePages.length });
      return () => controller.abort();
    }
    setState({ status: "loading", completed: 0, total: sitePages.length });
    void (async () => {
      const results: NormalizationDocument[] = new Array(sitePages.length);
      let cursor = 0, completed = 0;
      const readOne = async (index: number): Promise<NormalizationDocument> => {
        const page = sitePages[index]!;
        if (target && document && targetKey(page) === targetKey(target)) return { document, ...(presentation ? { presentation } : {}) };
        const snapshot = await adapter.readDocument(page, controller.signal);
        const parsed = parsePageDocument(snapshot.document, blocks, { ...(components ? { components } : {}), siteStyles });
        if (targetKey(parsed) !== targetKey(page)) throw new Error("ページの読込対象が一覧と一致しません。");
        const parsedPresentation = snapshot.presentation === undefined ? undefined : parseSitePresentation(snapshot.presentation, parsed, blocks);
        return { document: parsed,
          ...(snapshot.componentsVersion === undefined ? {} : { componentsVersion: snapshot.componentsVersion }),
          ...(snapshot.presentationVersion === undefined ? {} : { presentationVersion: snapshot.presentationVersion }),
          ...(parsedPresentation ? { presentation: parsedPresentation } : {}) };
      };
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = cursor++;
          if (index >= sitePages.length) return;
          const result = await readOne(index);
          if (controller.signal.aborted) return;
          results[index] = result;
          completed++;
          setState({ status: "loading", completed, total: sitePages.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, sitePages.length) }, worker));
      if (controller.signal.aborted) return;
      if (results.some((entry) => !entry)) throw new Error("一部のページを確認できませんでした。");
      const analysis = analyzeNormalization({ documents: results, siteStyles, ...(components ? { components } : {}),
        breakpoints: settings.breakpoints.map(({ minWidth }) => minWidth) });
      setState({ status: "ready", analysis, documentCount: sitePages.length });
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort();
        setState({ status: "error", message: error instanceof Error ? error.message : "全ページを分析できませんでした。" });
      }
    });
    return () => controller.abort();
  }, [adapter, pages, target?.siteId, target?.pageId, target?.locale, document, presentation, siteStyles, siteStylesReady, siteStylesFailed, components, componentsReady, componentsFailed, blocks, settings, settingsStatus, epoch]);
  return { state, retry: () => setEpoch((value) => value + 1) };
}

function changedWidths(before: EditorBreakpointSettings, after: EditorBreakpointSettings): { name: EditorBreakpointName; before: number; after: string }[] {
  const next = new Map(after.breakpoints.map((entry) => [entry.name, entry.minWidth]));
  return before.breakpoints.filter((entry) => next.get(entry.name) !== entry.minWidth).map((entry) => ({
    name: entry.name, before: entry.minWidth,
    after: next.has(entry.name) ? `${next.get(entry.name)}px` : after.base.name === entry.name ? "基本段" : "削除"
  }));
}

const emptySiteStyles: SiteStyles = {};

export function BreakpointSettingsDialog({ state, document, target, presentation, pages, adapter, siteStyles = emptySiteStyles, siteStylesReady = true, siteStylesFailed = false,
  components, componentsReady = true, componentsFailed = false, blocks = {}, saveBlockedReason, retryDependencies, close }: {
  state: BreakpointSettingsState;
  document?: PageDocument;
  target?: EditorTarget;
  presentation?: SitePresentation;
  pages: readonly EditorPage[];
  adapter: EditorAdapter;
  siteStyles?: SiteStyles;
  siteStylesReady?: boolean;
  siteStylesFailed?: boolean;
  components?: ComponentLibrary;
  componentsReady?: boolean;
  componentsFailed?: boolean;
  blocks?: EditorBlockRegistry;
  saveBlockedReason?: string;
  retryDependencies?(): void;
  close(): void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(state.settings)), [addName, setAddName] = useState<EditorBreakpointName | "">(""), [confirmed, setConfirmed] = useState(false), [operationMessage, setOperationMessage] = useState("");
  useEffect(() => { setDraft(structuredClone(state.settings)); setConfirmed(false); setOperationMessage(""); }, [state.settings]);
  const available = order.filter((name) => name !== draft.base.name && !draft.breakpoints.some((entry) => entry.name === name));
  const affectedWidths = changedWidths(state.settings, draft), affectedCount = document ? affectedWidths.reduce((sum, value) => sum + breakpointUsageCount(document, value.before), 0) : null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const usageAnalysis = useBreakpointAnalysis({ adapter, pages, ...(target ? { target } : {}), ...(document ? { document } : {}), ...(presentation ? { presentation } : {}),
    siteStyles, siteStylesReady, siteStylesFailed, ...(components ? { components } : {}), componentsReady, componentsFailed, blocks,
    settings: state.settings, settingsStatus: state.status });
  const nameByWidth = new Map(state.settings.breakpoints.map(({ name, minWidth }) => [minWidth, breakpointLabels[name]]));
  const unused = usageAnalysis.state.status === "ready" ? usageAnalysis.state.analysis.unusedBreakpoints : [];
  const nearby = usageAnalysis.state.status === "ready" ? usageAnalysis.state.analysis.nearbyBreakpoints : [];
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
    <section className="e-breakpoint-analysis" aria-label="文書全体の表示幅分析">
      <h3>文書全体の表示幅分析</h3>
      {(usageAnalysis.state.status === "waiting" || usageAnalysis.state.status === "loading") && <p role="status">{usageAnalysis.state.status === "waiting" ? "共通設定と部品を読み込んでいます…" : `全 ${usageAnalysis.state.total} 文書を確認中… ${usageAnalysis.state.completed} / ${usageAnalysis.state.total}`}</p>}
      {usageAnalysis.state.status === "error" && <div role="alert"><p>{usageAnalysis.state.message}</p><button type="button" onClick={() => { retryDependencies?.(); usageAnalysis.retry(); }}>文書分析を再試行</button></div>}
      {usageAnalysis.state.status === "ready" && <>
        <p>保存済み設定で全 {usageAnalysis.state.documentCount} 文書と共通内容を確認しました。</p>
        {unused.length === 0 ? <p>使われていない設定段はありません。</p> : <div><strong>どの文書からも使われていない段</strong><ul>{unused.map((width) => <li key={width}>{nameByWidth.get(width) ?? "設定段"} {width}px</li>)}</ul></div>}
        {nearby.length === 0 ? <p>48px 以内の近接した段はありません。</p> : <div><strong>近接した段（48px以内）</strong><ul>{nearby.map(({ from, into }) => <li key={`${from}-${into}`}>{nameByWidth.get(from) ?? "文書の段"} {from}px と {nameByWidth.get(into) ?? "文書の段"} {into}px（差 {from - into}px）</li>)}</ul></div>}
        {(unused.length > 0 || nearby.length > 0) && <p>削除・統合を検討する場合は <a href="https://github.com/niho-life/niho-web/blob/main/docs/normalization-contract.md#cli-での適用と再開" target="_blank" rel="noreferrer">正規化の plan 手順</a>で提案を作成し、幅別プレビューと変更内容を確認してから適用してください。</p>}
      </>}
    </section>
    {(operationMessage || validation) && <p className="e-problem" role="alert">{operationMessage || validation}</p>}
    {affectedWidths.length > 0 && <div className="e-breakpoint-impact" role="note"><strong>既存の幅指定は残ります</strong><ul>{affectedWidths.map((entry) => <li key={entry.name}>{breakpointLabels[entry.name]}: {entry.before}px → {entry.after}</li>)}</ul><p>上記の開始幅は現在のページに {affectedCount === null ? "確認できない件数" : `${affectedCount}件`} あります。設定を保存しても文書内の指定は移行・削除されず、ほかの全ページと共通内容にも影響し得ます。</p><label><input type="checkbox" checked={confirmed} disabled={disabled} onChange={(event) => setConfirmed(event.target.checked)} /> 内容を確認しました</label></div>}
    {saveBlockedReason && <p className="e-help e-problem">{saveBlockedReason}</p>}
    {state.conflict && <div className="e-breakpoint-conflict" role="alert"><p>{state.message}</p><button type="button" onClick={state.reload}>編集中の変更を破棄して再読み込み</button></div>}
    {!state.conflict && state.message && state.status !== "error" && <p className="e-problem" role="alert">{state.message}</p>}
    <div className="e-dialog-actions"><button type="button" onClick={close}>閉じる</button><button type="button" className="e-primary" disabled={disabled || !dirty || !!validation || !!operationMessage || !!saveBlockedReason || affectedWidths.length > 0 && !confirmed} onClick={() => void state.save(parseBreakpointSettings(draft))}>{state.busy ? "保存中…" : "サイト設定を保存"}</button></div>
  </Dialog>;
}

export const breakpointPreview = (settings: EditorBreakpointSettings) => ({ breakpoints: breakpointSettingsBreakpoints(settings), basePreviewWidth: settings.base.previewWidth, baseLabel: breakpointLabels[settings.base.name] });
