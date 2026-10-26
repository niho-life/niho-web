"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, DateTime, formatDateTime, Icon, useRequests, zoneLabel, type ConfirmRequest, type Outcome } from "./collection-ui.js";
import {
  isLocalizationItemKey, isSafeNavigationUrl, LOCALIZATION_LIMITS, localizationItemFilter, parseLocalizationCatalogResult, parseLocalizationListResult, parseLocalizationOverviewResult,
  parseLocalizationSettingsResult,
  type LocaleReleaseHistoryEntry, type LocaleReleasePending, type LocalizationFilter, type LocalizationItemSummary, type LocalizationListResult, type LocalizationOverview,
  type LocalizationSettings, type LocalizationWorkspaceAdapter,
} from "./localization-workspace-model.js";
import { ItemEditor } from "./localization-workspace-item.js";
import { HistoryDialog, ReleaseDialog, type ReleaseStart } from "./localization-workspace-release.js";
import { localizationWorkspaceCss } from "./localization-workspace-style.js";
import { ItemStateBadge, pause, Progress } from "./localization-workspace-ui.js";

export * from "./localization-workspace-model.js";
export { localizationWorkspaceCss } from "./localization-workspace-style.js";

export type LocalizationNavigationState = { readonly view: "list" | "item" | "settings"; readonly itemKey: string | null };
export type LocalizationWorkspaceProps = {
  adapter: LocalizationWorkspaceAdapter;
  /** 最初に開く 1 件。 */
  initialItemKey?: string;
  /** 最初の画面（既定は一覧）。 */
  initialView?: "list" | "settings";
  /** 一覧・1 件・設定を移ったとき。ホストが URL を合わせる。最初の表示では呼ばない。 */
  onNavigate?: (state: LocalizationNavigationState) => void;
  /** 日時の表示のタイムゾーン。既定は Asia/Tokyo（日本時間）。 */
  timeZone?: string;
  /** 直してから自動で保存するまでの待ち時間（ms）。既定は 1000。 */
  autosaveDelay?: number;
  /** 翻訳の依頼・原文の取り込みを読み直す間隔（ms）。既定は 2000。 */
  pollInterval?: number;
};

/** 翻訳の画面。adapter を差し替えると中身を作り直し、古い応答を捨てる。 */
export function LocalizationWorkspace(props: LocalizationWorkspaceProps) {
  const [source, setSource] = useState({ adapter: props.adapter, generation: 0 });
  if (source.adapter !== props.adapter) { setSource({ adapter: props.adapter, generation: source.generation + 1 }); return null; }
  return <Session key={source.generation} {...props} />;
}

/** CMS など、原文の編集画面の中で同じ 1 件だけを直す入口。 */
export function LocalizationItemWorkspace({ adapter, itemKey, onBack, registerBack, timeZone = "Asia/Tokyo", autosaveDelay = 1000, pollInterval = 2000 }: {
  adapter: LocalizationWorkspaceAdapter; itemKey: string; onBack: () => void; registerBack?: (back: (() => void) | null) => void; timeZone?: string; autosaveDelay?: number; pollInterval?: number;
}) {
  const [overview, setOverview] = useState<OverviewState>({ status: "loading" });
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [retry, setRetry] = useState(0);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setOverview({ status: "loading" });
    setSyncProgress(null);
    void (async () => {
      try {
        let result = parseLocalizationOverviewResult(await adapter.loadOverview(controller.signal));
        if (result.status === "ready" && result.overview.catalog.state === "updating" && result.overview.permissions.includes("edit")) {
          for (let round = 0; round < 500 && result.status === "ready" && result.overview.catalog.state === "updating"; round++) {
            if (controller.signal.aborted) return;
            const progress = result.overview.catalog.progress;
            setSyncProgress(`原文を同期中: ${progress.done}/${progress.total}`);
            if (round > 0 && !(await pause(pollInterval, () => controller.signal.aborted))) return;
            const next = parseLocalizationCatalogResult(await adapter.advanceCatalog({}, controller.signal));
            if (next.status === "forbidden") { if (!controller.signal.aborted) setOverview({ status: "forbidden" }); return; }
            result = parseLocalizationOverviewResult(await adapter.loadOverview(controller.signal));
          }
          if (result.status === "ready" && result.overview.catalog.state === "updating") throw new Error("catalog sync timed out");
        }
        if (!controller.signal.aborted) { setSyncProgress(null); setOverview(result.status === "forbidden" ? { status: "forbidden" } : { status: "ready", overview: result.overview }); }
      } catch { if (!controller.signal.aborted) { setSyncProgress(null); setOverview({ status: "error" }); } }
    })();
    return () => controller.abort();
  }, [adapter, pollInterval, retry]);
  return <section className="nw-collection nw-localization" aria-label={overview.status === "ready" ? `${overview.overview.languages.target}の翻訳` : "翻訳"}>
    <style dangerouslySetInnerHTML={{ __html: localizationWorkspaceCss }} />
    {overview.status === "ready" && isLocalizationItemKey(itemKey)
      ? <ItemEditor key={itemKey} adapter={adapter} overview={overview.overview} itemKey={itemKey} timeZone={timeZone} autosaveDelay={autosaveDelay} pollInterval={pollInterval}
          backLabel={`${overview.overview.languages.source}へ`} hideSourceLink {...(registerBack ? { registerBack } : {})} confirm={setConfirm} onSummary={() => {}} onForbidden={() => setOverview({ status: "forbidden" })} onBack={onBack} />
      : syncProgress && overview.status === "loading" ? <div className="cw-notice"><p role="status">{syncProgress}</p></div>
        : <Notice status={overview.status === "ready" ? "error" : overview.status} noun="翻訳" retry={() => setRetry((count) => count + 1)} />}
    {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
  </section>;
}

type OverviewState = { readonly status: "loading" | "error" | "forbidden" } | { readonly status: "ready"; readonly overview: LocalizationOverview };
type ListState = { readonly status: "loading" | "error" | "forbidden" } | { readonly status: "ready"; readonly items: readonly LocalizationItemSummary[]; readonly more: "loading" | "done" | "error" | "truncated" };
type View = { readonly view: "list" | "item" | "settings"; readonly itemKey: string | null };
type DialogState = { readonly kind: "release"; readonly start: ReleaseStart } | { readonly kind: "history" };

function Notice({ status, noun, retry }: { status: "loading" | "error" | "forbidden"; noun: string; retry?: () => void }) {
  return <div className="cw-notice" aria-busy={status === "loading"}>
    <p role={status === "loading" ? "status" : "alert"}>{status === "loading" ? `${noun}を読み込んでいます…` : status === "forbidden" ? `${noun}を見る権限がありません。管理者に確かめてください。` : `${noun}を読み込めませんでした。`}</p>
    {status !== "loading" && retry && <button type="button" className="cw-button" onClick={retry}>再試行</button>}
  </div>;
}

function Session({ adapter, initialItemKey, initialView, onNavigate, timeZone = "Asia/Tokyo", autosaveDelay = 1000, pollInterval = 2000 }: LocalizationWorkspaceProps) {
  const requests = useRequests();
  const [overview, setOverview] = useState<OverviewState>({ status: "loading" });
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [view, setView] = useState<View>(initialItemKey !== undefined && isLocalizationItemKey(initialItemKey) ? { view: "item", itemKey: initialItemKey } : { view: initialView ?? "list", itemKey: null });
  const [group, setGroup] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [toast, setToast] = useState<{ readonly text: string; readonly error: boolean; readonly id: number } | null>(null);
  const [focusItem, setFocusItem] = useState<string | null>(null);
  const [catalogStalled, setCatalogStalled] = useState(false);
  const overviewSeq = useRef(0), listSeq = useRef(0), toastSeq = useRef(0), catalogRun = useRef(0);

  const notify = useCallback((text: string, error = false) => setToast({ text, error, id: ++toastSeq.current }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 10_000 : 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const loadOverview = useCallback(async (quiet = false) => {
    const seq = ++overviewSeq.current;
    if (!quiet) setOverview({ status: "loading" });
    const outcome = await requests.current.run(async (signal) => parseLocalizationOverviewResult(await adapter.loadOverview(signal)));
    if (outcome.kind === "aborted" || seq !== overviewSeq.current) return;
    if (outcome.kind === "error") { if (!quiet) setOverview({ status: "error" }); return; }
    setOverview(outcome.value.status === "forbidden" ? { status: "forbidden" } : { status: "ready", overview: outcome.value.overview });
  }, [adapter, requests]);

  const loadList = useCallback(async (quiet = false) => {
    const seq = ++listSeq.current;
    if (!quiet) setList({ status: "loading" });
    const merged = new Map<string, LocalizationItemSummary>();
    let cursor: string | null = null;
    for (let page = 0; page < LOCALIZATION_LIMITS.listPages; page++) {
      const current: string | null = cursor;
      const outcome: Outcome<LocalizationListResult> = await requests.current.run(async (signal) => parseLocalizationListResult(await adapter.listItems({ cursor: current }, signal)));
      if (outcome.kind === "aborted" || seq !== listSeq.current) return;
      if (outcome.kind === "error") {
        if (page === 0) { if (!quiet) setList({ status: "error" }); }
        else if (!quiet) setList({ status: "ready", items: [...merged.values()], more: "error" });
        return;
      }
      if (outcome.value.status === "forbidden") { setList({ status: "forbidden" }); return; }
      for (const item of outcome.value.items) merged.set(item.key, item);
      cursor = outcome.value.nextCursor;
      // 段階で出す（静かに読み直すときは、全部そろってから入れ替える）
      if (!quiet || cursor === null) setList({ status: "ready", items: [...merged.values()], more: cursor === null ? "done" : "loading" });
      if (cursor === null) return;
    }
    setList({ status: "ready", items: [...merged.values()], more: "truncated" });
  }, [adapter, requests]);

  useEffect(() => { void loadOverview(); void loadList(); }, [loadOverview, loadList]);

  /* ---------- 原文の取り込みを自動で進める ---------- */
  const ready = overview.status === "ready" ? overview.overview : null;
  const updating = ready?.catalog.state === "updating";
  const canAdvance = !!ready?.permissions.includes("edit");
  useEffect(() => {
    if (!updating) return;
    const run = ++catalogRun.current;
    const stopped = () => run !== catalogRun.current || requests.current.isClosed;
    setCatalogStalled(false);
    void (async () => {
      for (let round = 0; round < 500; round++) {
        if (round > 0 && !(await pause(pollInterval, stopped))) return;
        if (!canAdvance) {
          // 進める権限が無ければ、概要を読み直して終わるのを待つだけ
          await loadOverview(true);
          continue;
        }
        const outcome = await requests.current.run(async (signal) => parseLocalizationCatalogResult(await adapter.advanceCatalog({}, signal)));
        if (outcome.kind === "aborted" || stopped()) return;
        if (outcome.kind === "error") { setCatalogStalled(true); return; }
        const result = outcome.value;
        if (result.status === "forbidden") return;
        if (result.status === "current") { await loadOverview(true); return; }
        setOverview((previous) => previous.status === "ready" ? { status: "ready", overview: { ...previous.overview, catalog: { state: "updating", progress: result.progress } } } : previous);
      }
    })();
    return () => { catalogRun.current++; };
  }, [updating, canAdvance, adapter, requests, pollInterval, loadOverview]);

  // 取り込みが終わったら（進めたのが自分でも、ほかの人でも）一覧を読み直す
  const wasUpdating = useRef(false);
  useEffect(() => {
    if (wasUpdating.current && !updating) void loadList(true);
    wasUpdating.current = !!updating;
  }, [updating, loadList]);

  const go = (next: View) => { setView(next); onNavigate?.(next); };
  const upsert = useCallback((summary: LocalizationItemSummary) => setList((previous) => {
    if (previous.status !== "ready") return previous;
    const index = previous.items.findIndex((entry) => entry.key === summary.key);
    return { ...previous, items: index < 0 ? [...previous.items, summary] : previous.items.map((entry, position) => position === index ? summary : entry) };
  }), []);

  let body: ReactNode;
  if (overview.status !== "ready") body = <Notice status={overview.status} noun="翻訳" retry={() => { void loadOverview(); void loadList(); }} />;
  else {
    const current = overview.overview;
    if (view.view === "item" && view.itemKey !== null) {
      const itemKey = view.itemKey;
      body = <ItemEditor key={itemKey} adapter={adapter} overview={current} itemKey={itemKey} timeZone={timeZone} autosaveDelay={autosaveDelay} pollInterval={pollInterval}
        confirm={setConfirm} onSummary={upsert} onForbidden={() => void loadOverview(true)}
        onBack={() => { go({ view: "list", itemKey: null }); setFocusItem(itemKey); void loadOverview(true); }} />;
    } else if (view.view === "settings") {
      body = <SettingsView adapter={adapter} overview={current} timeZone={timeZone} onBack={() => go({ view: "list", itemKey: null })}
        onSaved={(settings) => setOverview({ status: "ready", overview: { ...current, settings } })} />;
    } else {
      body = <>
        <LocaleBand overview={current} list={list} timeZone={timeZone} catalogStalled={catalogStalled}
          onRetryCatalog={() => { setCatalogStalled(false); void loadOverview(true); }}
          onPublish={() => setDialog({ kind: "release", start: { kind: "publish" } })} onHistory={() => setDialog({ kind: "history" })}
          onResume={(pending) => setDialog({ kind: "release", start: { kind: "resume", pending } })} onSettings={() => go({ view: "settings", itemKey: null })} />
        <ListView adapter={adapter} overview={current} list={list} group={group} onGroup={setGroup} timeZone={timeZone} focusItem={focusItem} onFocused={() => setFocusItem(null)}
          onOpen={(itemKey) => go({ view: "item", itemKey })} onRetry={() => void loadList()} />
      </>;
    }
  }
  const current = overview.status === "ready" ? overview.overview : null;
  const canResume = (pending: LocaleReleasePending) => !!current?.permissions.includes(pending.operation === "rollback" ? "rollback" : "publish");
  return <section className="nw-collection nw-localization" aria-label="翻訳"><style dangerouslySetInnerHTML={{ __html: localizationWorkspaceCss }} />
    {body}
    <div className="cw-toast-region">{toast && <div key={toast.id} className="cw-toast" data-tone={toast.error ? "error" : "info"} role={toast.error ? "alert" : "status"}>
      <p>{toast.text}</p><button type="button" className="cw-icon-button" aria-label="知らせを閉じる" onClick={() => setToast(null)}><Icon name="close" /></button>
    </div>}</div>
    {current && dialog?.kind === "release" && <ReleaseDialog adapter={adapter} start={dialog.start} overview={current} timeZone={timeZone}
      onClose={() => { setDialog(null); void loadOverview(true); }} onOverview={(next) => setOverview({ status: "ready", overview: next })}
      onDone={() => { void loadOverview(true); notify(dialog.start.kind === "rollback" ? "戻しました。" : "公開しました。"); }}
      onOpenItem={(itemKey) => { setDialog(null); go({ view: "item", itemKey }); }} />}
    {current && dialog?.kind === "history" && <HistoryDialog adapter={adapter} overview={current} timeZone={timeZone}
      canRollback={current.permissions.includes("rollback")} canResume={!!current.release.pending && canResume(current.release.pending)}
      onClose={() => setDialog(null)} onRollback={(target: LocaleReleaseHistoryEntry) => setDialog({ kind: "release", start: { kind: "rollback", target } })}
      onResume={(pending) => setDialog({ kind: "release", start: { kind: "resume", pending } })} />}
    {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
  </section>;
}

/* ---------- 「English版」の帯 ---------- */

function LocaleBand({ overview, list, timeZone, catalogStalled, onRetryCatalog, onPublish, onHistory, onResume, onSettings }: {
  overview: LocalizationOverview; list: ListState; timeZone: string; catalogStalled: boolean; onRetryCatalog: () => void;
  onPublish: () => void; onHistory: () => void; onResume: (pending: LocaleReleasePending) => void; onSettings: () => void;
}) {
  const target = overview.languages.target, current = overview.release.current, pending = overview.release.pending;
  const totals = overview.groups.reduce((sum, group) => ({ items: sum.items + group.items - group.excluded, reviewed: sum.reviewed + group.reviewed }), { items: 0, reviewed: 0 });
  const canPublish = overview.permissions.includes("publish");
  const canResume = !!pending && overview.permissions.includes(pending.operation === "rollback" ? "rollback" : "publish");
  return <section className="lw-band" aria-label={`${target}版`}>
    <div className="lw-band-main">
      <h2>{target}版</h2>
      <p className="lw-band-line">{current ? <span>公開中：{current.label}（<time dateTime={current.publishedAt}>{formatDateTime(current.publishedAt, timeZone)}</time>）</span> : "まだ公開していません"}</p>
      <Progress label="確認済み" done={totals.reviewed} total={totals.items} />
      {list.status === "ready" && list.more === "loading" && <span className="cw-hint" role="status">残りを読み込んでいます…（{list.items.length} 件まで）</span>}
      {overview.catalog.state === "updating" && <span className="lw-band-line" role="status"><Progress label={`${overview.languages.source}の原文を取り込んでいます`} done={overview.catalog.progress.done} total={overview.catalog.progress.total} /></span>}
      {catalogStalled && <p className="cw-error" role="alert"><Icon name="alert" />原文の取り込みが止まりました。<button type="button" className="cw-link-button" onClick={onRetryCatalog}>再試行</button></p>}
      {pending && <p className="lw-band-line lw-pending" role="status"><span><strong>前回の{pending.operation === "rollback" ? "戻し" : "公開"}が途中です。</strong>
        （{pending.stage === "apply" ? "反映" : "準備"} {pending.progress.done}/{pending.progress.total}）</span>
        {canResume && <button type="button" className="cw-button" onClick={() => onResume(pending)}>続ける</button>}</p>}
    </div>
    <div className="lw-band-actions">
      <button type="button" className="cw-button" onClick={onSettings}>設定</button>
      <button type="button" className="cw-button" onClick={onHistory}>公開の履歴</button>
      {canPublish && <button type="button" className="cw-button cw-primary" disabled={!!pending} onClick={onPublish}>{target}版を公開…</button>}
    </div>
  </section>;
}

/* ---------- 一覧 ---------- */

const filterTabs: readonly [LocalizationFilter, string][] = [["needs-work", "要対応"], ["reviewed", "確認済み"], ["all", "すべて"], ["excluded", "対象外"]];

function ListView({ adapter, overview, list, group, onGroup, timeZone, focusItem, onFocused, onOpen, onRetry }: {
  adapter: LocalizationWorkspaceAdapter; overview: LocalizationOverview; list: ListState; group: string | null; onGroup: (group: string | null) => void; timeZone: string;
  focusItem: string | null; onFocused: () => void; onOpen: (itemKey: string) => void; onRetry: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LocalizationFilter>(focusItem ? "all" : "needs-work");
  const rowsRef = useRef<HTMLDivElement>(null);
  const items = list.status === "ready" ? list.items : null;
  const inGroup = useMemo(() => (items ?? []).filter((item) => group === null || item.groupId === group), [items, group]);
  const counts = useMemo(() => ({
    all: inGroup.length,
    "needs-work": inGroup.filter((item) => localizationItemFilter(item.state) === "needs-work").length,
    reviewed: inGroup.filter((item) => item.state === "reviewed").length,
    excluded: inGroup.filter((item) => item.state === "excluded").length,
  }), [inGroup]);
  const needle = query.trim().toLocaleLowerCase("ja-JP");
  const visible = inGroup.filter((item) => (filter === "all" || localizationItemFilter(item.state) === filter) &&
    (!needle || item.title.toLocaleLowerCase("ja-JP").includes(needle) || (item.path ?? "").toLocaleLowerCase("ja-JP").includes(needle)));
  const active = visible.filter((item) => item.state !== "excluded");
  const excluded = visible.filter((item) => item.state === "excluded");
  useEffect(() => {
    if (!items || !focusItem) return;
    const target = Array.from(rowsRef.current?.querySelectorAll<HTMLButtonElement>("button.cw-row-open") ?? []).find((node) => node.dataset.itemKey === focusItem);
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused();
  }, [items, focusItem, onFocused]);
  const total = overview.groups.reduce((sum, entry) => sum + entry.items, 0);
  const groupLabel = group === null ? "すべて" : overview.groups.find((entry) => entry.id === group)?.label ?? "すべて";
  const rows = (entries: readonly LocalizationItemSummary[], label: string) => <>
    <div className="cw-rows-head lw-rows-head" aria-hidden="true"><span>題名</span><span>状態</span><span>確認済み</span><span>最終更新</span></div>
    <ul className="cw-rows lw-rows" aria-label={label}>{entries.map((item) => {
      let source: string | null = null;
      try { source = adapter.sourceLink?.(item.key) ?? null; } catch { source = null; }
      if (source !== null && !isSafeNavigationUrl(source)) source = null;
      const sub = item.state === "excluded" ? `訳さない理由：${item.excludedReason}` : item.path;
      return <li className="cw-row lw-row" key={item.key}>
        <button type="button" className="cw-row-open" data-item-key={item.key} onClick={() => onOpen(item.key)}>
          <span className="cw-row-text"><span className="cw-row-title">{item.title || "無題"}</span>{sub && <span className="cw-row-sub">{sub}</span>}</span>
        </button>
        <span className="cw-row-meta">
          <span className="cw-cell cw-cell-status"><span className="cw-cell-label">状態</span><span className="cw-badges"><ItemStateBadge state={item.state} />
            {item.imagesUnreviewed > 0 && <span className="cw-pill lw-pill" data-lw-state="images"><Icon name="image" />未確認の画像 {item.imagesUnreviewed}</span>}
            {item.sourceDraftPending && <span className="cw-pill lw-pill" data-lw-state="pending-source">原文に未公開の下書き</span>}</span></span>
          <span className="cw-cell lw-cell-reviewed"><span className="cw-cell-label">確認済み</span>{item.state === "excluded" ? "—" : `${item.reviewedUnits}/${item.totalUnits}`}</span>
          <span className="cw-cell cw-cell-updated"><span className="cw-cell-label">最終更新</span><DateTime value={item.updatedAt} timeZone={timeZone} />{item.updatedBy && <span className="cw-by">{item.updatedBy}</span>}{source && <a className="lw-source-link" href={source} target="_blank" rel="noopener noreferrer">原文を編集<span className="cw-sr">（新しいタブで開く）</span></a>}</span>
        </span>
      </li>;
    })}</ul>
  </>;
  return <div className="cw-layout">
    <nav className="cw-nav" aria-label="コンテンツ">
      <h2 className="cw-nav-heading">コンテンツ</h2>
      <ul>
        <li><button type="button" aria-current={group === null ? "page" : undefined} onClick={() => onGroup(null)}><span className="cw-nav-label">すべて</span>
          <span className="cw-nav-count"><span className="cw-sr">（</span>{total}<span className="cw-sr"> 件）</span></span></button></li>
        {overview.groups.map((entry) => <li key={entry.id}><button type="button" aria-current={group === entry.id ? "page" : undefined} onClick={() => onGroup(entry.id)}>
          <span className="cw-nav-label">{entry.label}</span>
          <span className="cw-nav-count"><span className="cw-sr">（</span>{entry.items}<span className="cw-sr"> 件{entry.needsWork ? `・要対応 ${entry.needsWork} 件` : ""}）</span></span>
          {entry.needsWork > 0 && <span className="lw-needs" aria-hidden="true">{entry.needsWork}</span>}
        </button></li>)}
      </ul>
    </nav>
    <div className="cw-main">
      <div className="cw-list" ref={rowsRef}>
        <header className="cw-list-head">
          <div className="cw-list-title"><h2>{groupLabel}</h2>{items && <span className="cw-count">{inGroup.length} 件</span>}</div>
          <div className="cw-list-actions">
            <label className="cw-search"><Icon name="search" /><span className="cw-sr">題名とアドレスで検索</span>
              <input type="search" value={query} placeholder="題名・アドレスで検索" autoComplete="off" onChange={(event) => { setQuery(event.target.value); if (event.target.value.trim()) setFilter("all"); }} /></label>
          </div>
        </header>
        {list.status !== "ready" ? <Notice status={list.status} noun="一覧" retry={onRetry} /> : <>
          <div className="cw-filters" role="group" aria-label="状態で絞り込む">{filterTabs.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {label}<span className="cw-filter-count"><span className="cw-sr">（</span>{counts[value]}<span className="cw-sr"> 件）</span></span></button>)}</div>
          {list.more === "error" && <p className="cw-error" role="alert"><Icon name="alert" />一覧の残りを読み込めませんでした。<button type="button" className="cw-link-button" onClick={onRetry}>読み込み直す</button></p>}
          {list.more === "truncated" && <p className="cw-hint">件数が多いため、一部だけを出しています。検索で絞り込んでください。</p>}
          {inGroup.length === 0 ? <div className="cw-empty"><p>{list.more === "loading" ? "読み込んでいます…" : "訳すものはありません。"}</p></div>
            : visible.length === 0 ? <div className="cw-empty"><p>{needle ? `「${query.trim()}」に当てはまるものはありません。` : `${filterTabs.find(([value]) => value === filter)?.[1]}のものはありません。`}</p>
              <button type="button" className="cw-button" onClick={() => { setQuery(""); setFilter("all"); }}>{!needle && filter === "needs-work" ? "すべてを見る" : "絞り込みをやめる"}</button></div>
            : <>
              <p className="cw-sr" role="status">{visible.length} 件が見つかりました{filter !== "excluded" && excluded.length > 0 ? `。対象外 ${excluded.length} 件は別のまとまりにあります` : ""}</p>
              {filter === "excluded" ? rows(excluded, `${groupLabel}の対象外`) : <>
                {active.length > 0 && rows(active, `${groupLabel}の一覧`)}
                {excluded.length > 0 && <details className="lw-excluded" key={`${group ?? "all"}:${needle}`} open={!!needle || excluded.some((item) => item.key === focusItem)}>
                  <summary>対象外 <span>{excluded.length} 件</span></summary>
                  {rows(excluded, `${groupLabel}の対象外`)}
                </details>}
              </>}
            </>}
        </>}
      </div>
    </div>
  </div>;
}

/* ---------- 設定 ---------- */

function SettingsView({ adapter, overview, timeZone, onBack, onSaved }: {
  adapter: LocalizationWorkspaceAdapter; overview: LocalizationOverview; timeZone: string; onBack: () => void; onSaved: (settings: LocalizationSettings) => void;
}) {
  const requests = useRequests();
  const settings = overview.settings, canChange = overview.permissions.includes("settings");
  const [autoDraft, setAutoDraft] = useState(settings.autoDraft);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const outcome = await requests.current.run(async (signal) => parseLocalizationSettingsResult(await adapter.saveSettings({ expectedVersion: settings.version, autoDraft }, signal)));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setNote({ text: "保存できませんでした。もう一度試してください。", error: true }); return; }
      const result = outcome.value;
      if (result.status === "saved") { onSaved(result.settings); setAutoDraft(result.settings.autoDraft); setNote({ text: "保存しました。", error: false }); }
      else if (result.status === "conflict") { onSaved(result.settings); setAutoDraft(result.settings.autoDraft); setNote({ text: "ほかの人が先に変えていました。最新の設定を出しています。", error: true }); }
      else if (result.status === "invalid") setNote({ text: result.message, error: true });
      else setNote({ text: "設定を変える権限がありません。", error: true });
    } finally { setBusy(false); }
  };
  return <div className="cw-editor lw-settings">
    <header className="cw-editor-bar"><button type="button" className="cw-back" onClick={onBack}><Icon name="back" /><span className="cw-back-label">一覧へ</span></button></header>
    <div className="lw-settings-body">
      <h2 ref={heading} tabIndex={-1}>{overview.languages.target}版の設定</h2>
      {!canChange && <p className="cw-banner" role="note">設定を変える権限がありません。見ることだけできます。</p>}
      <section className="lw-settings-card" aria-labelledby="lw-settings-auto">
        <h3 id="lw-settings-auto">翻訳案</h3>
        <label className="lw-check"><input type="checkbox" checked={autoDraft} disabled={!canChange || busy} onChange={(event) => setAutoDraft(event.target.checked)} />
          <span>{overview.languages.source}が変わったら、翻訳案を自動で作る</span></label>
        <p className="cw-hint">翻訳案は「下書き」として項目に入ります。公開する前に、人が 1 つずつ確かめます。</p>
        {canChange && <div className="lw-settings-actions"><button type="button" className="cw-button cw-primary" disabled={busy || autoDraft === settings.autoDraft} onClick={() => void save()}>{busy ? "保存しています…" : "保存する"}</button></div>}
        {note && <p className={note.error ? "cw-error" : "lw-note"} role={note.error ? "alert" : "status"}>{note.error && <Icon name="alert" />}{note.text}</p>}
      </section>
      <section className="lw-settings-card" aria-labelledby="lw-settings-service">
        <h3 id="lw-settings-service">翻訳サービス</h3>
        <dl className="cw-facts">
          <div><dt>つながり</dt><dd>{settings.translator.connected ? <span className="cw-pill" data-status="published"><span className="cw-dot" aria-hidden="true" />つながっています</span>
            : <span className="cw-pill" data-status="failed"><Icon name="alert" />つながっていません</span>}</dd></div>
          <div><dt>待っている件数</dt><dd>{settings.queue.waiting} 件</dd></div>
          <div><dt>失敗した件数</dt><dd>{settings.queue.failed} 件</dd></div>
          <div><dt>次の再試行</dt><dd>{settings.queue.nextRetryAt ? <>{formatDateTime(settings.queue.nextRetryAt, timeZone)}（{zoneLabel(timeZone)}）</> : "予定はありません"}</dd></div>
        </dl>
      </section>
    </div>
  </div>;
}
