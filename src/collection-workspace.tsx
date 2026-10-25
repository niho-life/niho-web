"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  collectionDateFromInput, collectionItemFilter, isDisplayableImageUrl, parseCollectionCreateResult, parseCollectionItemResult,
  parseCollectionListResult, parseCollectionPublishResult, parseCollectionRemoveResult, parseCollectionSaveResult, parseCollectionSchemaResult,
  parseCollectionUploadResult, sanitizeRichTextHtml, sortCollectionItems, validateCollectionValues,
  type CollectionAdapter, type CollectionDefinition, type CollectionFieldError, type CollectionFilter, type CollectionItem, type CollectionItemStatus,
  type CollectionItemSummary, type CollectionValue, type CollectionValues,
} from "./collection-model.js";
import { displayImage, FieldView, fieldControlId, rejectMessages, type CollectionRichTextEditorProps, type FieldContext, type ReferenceCandidates } from "./collection-fields.js";
import { ConfirmDialog, DateTime, formatDateTime, Icon, MenuButton, StatusBadges, useRequests, zoneLabel, type ConfirmRequest, type MenuItem } from "./collection-ui.js";
import { collectionCss } from "./collection-style.js";

export {
  collectionDateFromInput, collectionDateInputValue, collectionItemFilter, isIsoTimestamp, isRichTextLinkAllowed, parseCollectionCreateResult,
  parseCollectionItem, parseCollectionItemResult, parseCollectionItemSummary, parseCollectionListResult, parseCollectionPublishResult,
  parseCollectionRemoveResult, parseCollectionSaveResult, parseCollectionSchemaResult, parseCollectionUploadResult, parseCollectionValues,
  sanitizeRichTextHtml, sortCollectionItems, validateCollectionValues,
} from "./collection-model.js";
export type * from "./collection-model.js";
export type { CollectionRichTextEditorProps } from "./collection-fields.js";
export { DefaultRichText as CollectionRichTextEditor } from "./collection-fields.js";
export { collectionCss } from "./collection-style.js";

export type CollectionNavigationState = { readonly collectionId: string; readonly itemId: string | null };
export type CollectionWorkspaceProps = {
  adapter: CollectionAdapter;
  /** 最初に開くコレクション。無い・見つからないときは先頭。 */
  initialCollectionId?: string;
  /** 最初に開く項目（initialCollectionId と一緒に指定する）。 */
  initialItemId?: string;
  /** 一覧・項目を移ったとき。ホストが URL を合わせる。最初の表示では呼ばない。 */
  onNavigate?: (state: CollectionNavigationState) => void;
  /** リッチテキストの編集部品を差し替える。無ければ既定の contenteditable。 */
  renderRichText?: (props: CollectionRichTextEditorProps) => ReactNode;
  /** 日時の表示・入力のタイムゾーン。既定は Asia/Tokyo（日本時間）。 */
  timeZone?: string;
  /** 直してから下書きを自動で保存するまでの待ち時間（ms）。既定は 1000。 */
  autosaveDelay?: number;
};

type ListState = { readonly status: "loading" | "error" | "forbidden" } | { readonly status: "ready"; readonly items: readonly CollectionItemSummary[] };
type SchemaState = { readonly status: "loading" | "error" | "forbidden" } | { readonly status: "ready"; readonly collections: readonly CollectionDefinition[] };
type View = { readonly collectionId: string | null; readonly itemId: string | null; readonly created: CollectionItem | null };

const toSummary = (item: CollectionItem): CollectionItemSummary => ({
  id: item.id, title: item.title, subtitle: item.subtitle, imageUrl: item.imageUrl, path: item.path, status: item.status, publishedAt: item.publishedAt,
  updatedAt: item.updatedAt, updatedBy: item.updatedBy, scheduledAt: item.scheduledAt, publishFailed: item.publishFailed, order: item.order,
});

/** コレクション（CMS）の一覧と項目の編集。adapter を差し替えると中身を作り直し、古い応答を捨てる。 */
export function CollectionWorkspace(props: CollectionWorkspaceProps) {
  const [source, setSource] = useState({ adapter: props.adapter, generation: 0 });
  if (source.adapter !== props.adapter) { setSource({ adapter: props.adapter, generation: source.generation + 1 }); return null; }
  return <WorkspaceSession key={source.generation} {...props} />;
}

function Notice({ status, noun, retry }: { status: "loading" | "error" | "forbidden"; noun: string; retry?: () => void }) {
  return <div className="cw-notice" aria-busy={status === "loading"}>
    <p role={status === "loading" ? "status" : "alert"}>{status === "loading" ? `${noun}を読み込んでいます…` : status === "forbidden" ? `${noun}を見る権限がありません。管理者に確かめてください。` : `${noun}を読み込めませんでした。`}</p>
    {status !== "loading" && retry && <button type="button" className="cw-button" onClick={retry}>再試行</button>}
  </div>;
}

function WorkspaceSession({ adapter, initialCollectionId, initialItemId, onNavigate, renderRichText, timeZone = "Asia/Tokyo", autosaveDelay = 1000 }: CollectionWorkspaceProps) {
  const requests = useRequests();
  const [schema, setSchema] = useState<SchemaState>({ status: "loading" });
  const [lists, setLists] = useState<Readonly<Record<string, ListState>>>({});
  const [view, setView] = useState<View>({ collectionId: initialCollectionId ?? null, itemId: initialCollectionId !== undefined && initialItemId !== undefined ? initialItemId : null, created: null });
  const [toast, setToast] = useState<{ readonly text: string; readonly error: boolean; readonly id: number } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [focusItem, setFocusItem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const listSeq = useRef(new Map<string, number>()), schemaSeq = useRef(0), toastSeq = useRef(0);

  const notify = useCallback((text: string, error = false) => setToast({ text, error, id: ++toastSeq.current }), []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 10_000 : 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const setList = (collectionId: string, state: ListState) => setLists((previous) => ({ ...previous, [collectionId]: state }));
  const loadList = useCallback(async (collectionId: string, quiet = false) => {
    const seq = (listSeq.current.get(collectionId) ?? 0) + 1;
    listSeq.current.set(collectionId, seq);
    if (!quiet) setList(collectionId, { status: "loading" });
    const outcome = await requests.current.run(async (signal) => parseCollectionListResult(await adapter.listItems({ collectionId }, signal), collectionId));
    if (outcome.kind === "aborted" || listSeq.current.get(collectionId) !== seq) return;
    setLists((previous) => {
      const current = previous[collectionId];
      const next: ListState = outcome.kind === "error" ? (quiet && current?.status === "ready" ? current : { status: "error" })
        : outcome.value.status === "forbidden" ? { status: "forbidden" } : { status: "ready", items: outcome.value.items };
      return { ...previous, [collectionId]: next };
    });
  }, [adapter, requests]);

  const loadSchema = useCallback(async () => {
    const seq = ++schemaSeq.current;
    setSchema({ status: "loading" });
    const outcome = await requests.current.run(async (signal) => parseCollectionSchemaResult(await adapter.loadSchema(signal)));
    if (outcome.kind === "aborted" || seq !== schemaSeq.current) return;
    if (outcome.kind === "error") { setSchema({ status: "error" }); return; }
    if (outcome.value.status === "forbidden") { setSchema({ status: "forbidden" }); setLists({}); return; }
    const collections = outcome.value.collections;
    setSchema({ status: "ready", collections });
    setView((previous) => collections.some((definition) => definition.id === previous.collectionId) ? previous : { collectionId: collections[0]?.id ?? null, itemId: null, created: null });
    for (const definition of collections) void loadList(definition.id);
  }, [adapter, requests, loadList]);
  useEffect(() => { void loadSchema(); }, [loadSchema]);

  const go = (collectionId: string, itemId: string | null, created: CollectionItem | null = null) => {
    setView({ collectionId, itemId, created });
    onNavigate?.({ collectionId, itemId });
  };
  const upsert = useCallback((collectionId: string, item: CollectionItem) => setLists((previous) => {
    const state = previous[collectionId];
    if (state?.status !== "ready") return previous;
    const summary = toSummary(item), index = state.items.findIndex((entry) => entry.id === item.id);
    const items = index < 0 ? [summary, ...state.items] : state.items.map((entry, position) => position === index ? summary : entry);
    return { ...previous, [collectionId]: { status: "ready", items } };
  }), []);
  const drop = (collectionId: string, itemId: string) => setLists((previous) => {
    const state = previous[collectionId];
    return state?.status === "ready" ? { ...previous, [collectionId]: { status: "ready", items: state.items.filter((entry) => entry.id !== itemId) } } : previous;
  });

  const collections = schema.status === "ready" ? schema.collections : [];
  const definition = collections.find((candidate) => candidate.id === view.collectionId) ?? null;
  const references = (collectionId: string): ReferenceCandidates => {
    const state = lists[collectionId];
    return !state ? { status: "loading" } : state.status === "ready" ? { status: "ready", items: state.items } : { status: state.status };
  };

  /* ---------- 一覧からの操作（最新を読んで version を付けてから） ---------- */
  const afterListAction = (target: CollectionDefinition, status: string, success: string) => {
    if (status === "forbidden") { setList(target.id, { status: "forbidden" }); return; }
    if (status === "conflict") notify("ほかの人が先に変更していました。一覧を読み込み直したので、もう一度試してください。", true);
    else if (status === "invalid") notify("この操作はできませんでした。項目を開いて確かめてください。", true);
    else if (status === "not_found") notify("見つかりませんでした。削除されたかもしれません。一覧を読み込み直しました。", true);
    else notify(success);
    void loadList(target.id, true);
  };
  const withLatest = async (target: CollectionDefinition, summary: CollectionItemSummary, action: (item: CollectionItem) => Promise<void>) => {
    const outcome = await requests.current.run(async (signal) => parseCollectionItemResult(await adapter.loadItem({ collectionId: target.id, itemId: summary.id }, signal), target, summary.id));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { notify("操作できませんでした。もう一度試してください。", true); return; }
    if (outcome.value.status !== "ready") { afterListAction(target, outcome.value.status, ""); return; }
    await action(outcome.value.item);
  };
  const failed = () => notify("操作できませんでした。もう一度試してください。", true);
  const rowMenu = (target: CollectionDefinition, summary: CollectionItemSummary): MenuItem[] => {
    const title = summary.title || "無題", items: MenuItem[] = [{ label: "開く", onSelect: () => go(target.id, summary.id) }];
    if (target.capabilities.duplicate && adapter.duplicate) items.push({ label: "複製する", onSelect: () => void (async () => {
      const outcome = await requests.current.run(async (signal) => parseCollectionCreateResult(await adapter.duplicate!({ collectionId: target.id, itemId: summary.id }, signal), target));
      if (outcome.kind === "ok") afterListAction(target, outcome.value.status, "複製しました。下書きとして一覧に入っています。");
      else if (outcome.kind === "error") failed();
    })() });
    if (target.capabilities.unpublish && adapter.unpublish && (summary.status === "published" || summary.status === "changed")) items.push({ label: "非公開にする", onSelect: () => setConfirm({
      title: `「${title}」を非公開にしますか？`, body: "サイトから外れます。もう一度公開するまで、このアドレスは開けなくなります。", confirmLabel: "非公開にする", tone: "danger",
      run: () => withLatest(target, summary, async (item) => {
        const outcome = await requests.current.run(async (signal) => parseCollectionSaveResult(await adapter.unpublish!({ collectionId: target.id, itemId: item.id, version: item.version }, signal), target, item.id));
        if (outcome.kind === "ok") afterListAction(target, outcome.value.status, "非公開にしました。サイトから外れるまで少しかかります。");
        else if (outcome.kind === "error") failed();
      }),
    }) });
    if (target.capabilities.remove && adapter.remove) items.push({ label: "削除する", danger: true, onSelect: () => setConfirm({
      title: `「${title}」を削除しますか？`, body: summary.status === "draft" ? "削除は元に戻せません。" : "サイトからも外れます。削除は元に戻せません。", confirmLabel: "削除する", tone: "danger",
      run: () => withLatest(target, summary, async (item) => {
        const outcome = await requests.current.run(async (signal) => parseCollectionRemoveResult(await adapter.remove!({ collectionId: target.id, itemId: item.id, version: item.version }, signal), target, item.id));
        if (outcome.kind === "ok") { if (outcome.value.status === "removed") drop(target.id, item.id); afterListAction(target, outcome.value.status, "削除しました。"); }
        else if (outcome.kind === "error") failed();
      }),
    }) });
    return items;
  };
  const create = async (target: CollectionDefinition) => {
    if (!adapter.createItem || creating) return;
    setCreating(true);
    const outcome = await requests.current.run(async (signal) => parseCollectionCreateResult(await adapter.createItem!({ collectionId: target.id }, signal), target));
    setCreating(false);
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { notify("作れませんでした。もう一度試してください。", true); return; }
    if (outcome.value.status !== "created") { afterListAction(target, outcome.value.status, ""); return; }
    upsert(target.id, outcome.value.item);
    go(target.id, outcome.value.item.id, outcome.value.item);
  };

  let body: ReactNode;
  if (schema.status !== "ready") body = <Notice status={schema.status} noun="コンテンツ" retry={() => void loadSchema()} />;
  else if (!definition) body = <div className="cw-notice"><p>編集できるコレクションはありません。</p></div>;
  else if (view.itemId !== null) {
    const target = definition, itemId = view.itemId;
    body = <ItemEditor key={`${target.id}/${itemId}`} adapter={adapter} definition={target} itemId={itemId} created={view.created} timeZone={timeZone} autosaveDelay={autosaveDelay}
      renderRichText={renderRichText} references={references} retryReferences={(collectionId) => void loadList(collectionId)} confirm={setConfirm}
      onSaved={(item) => upsert(target.id, item)}
      onBack={() => { go(target.id, null); setFocusItem(itemId); void loadList(target.id, true); }}
      onRemoved={(message) => { drop(target.id, itemId); notify(message); go(target.id, null); void loadList(target.id, true); }}
      onOpenItem={(item) => { upsert(target.id, item); notify("複製しました。複製した下書きを開いています。"); go(target.id, item.id, item); }} />;
  } else {
    const state = lists[definition.id] ?? { status: "loading" as const };
    body = <div className="cw-layout">
      <nav className="cw-nav" aria-label="コレクション">
        <h2 className="cw-nav-heading">コンテンツ</h2>
        <ul>{collections.map((entry) => {
          const list = lists[entry.id];
          return <li key={entry.id}><button type="button" aria-current={entry.id === definition.id ? "page" : undefined} onClick={() => { if (entry.id !== definition.id) go(entry.id, null); }}>
            <Icon name={entry.icon ?? "document"} /><span className="cw-nav-label">{entry.label}</span>
            {list?.status === "ready" && <span className="cw-nav-count"><span className="cw-sr">（</span>{list.items.length}<span className="cw-sr"> 件）</span></span>}
          </button></li>;
        })}</ul>
      </nav>
      <div className="cw-main">
        <ItemList key={definition.id} definition={definition} state={state} timeZone={timeZone} focusItem={focusItem} onFocused={() => setFocusItem(null)}
          imageSrc={(url, width) => displayImage(url, width, adapter.imageUrl ? (value, size) => adapter.imageUrl!(value, size) : undefined)}
          canCreate={definition.capabilities.create && !!adapter.createItem} creating={creating} onCreate={() => void create(definition)}
          onOpen={(itemId) => go(definition.id, itemId)} onRetry={() => void loadList(definition.id)} menuFor={(summary) => rowMenu(definition, summary)} />
      </div>
    </div>;
  }
  return <section className="nw-collection" aria-label="コンテンツ"><style dangerouslySetInnerHTML={{ __html: collectionCss }} />
    {body}
    <div className="cw-toast-region">{toast && <div key={toast.id} className="cw-toast" data-tone={toast.error ? "error" : "info"} role={toast.error ? "alert" : "status"}>
      <p>{toast.text}</p><button type="button" className="cw-icon-button" aria-label="知らせを閉じる" onClick={() => setToast(null)}><Icon name="close" /></button>
    </div>}</div>
    {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
  </section>;
}

/* ---------- 一覧 ---------- */

function Thumb({ src }: { src: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return src && src !== failedSrc ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedSrc(src)} /> : <Icon name="image" />;
}

function ItemList({ definition, state, timeZone, focusItem, onFocused, imageSrc, canCreate, creating, onCreate, onOpen, onRetry, menuFor }: {
  definition: CollectionDefinition; state: ListState; timeZone: string; focusItem: string | null; onFocused: () => void;
  imageSrc: (url: string | null, width: number) => string | null; canCreate: boolean; creating: boolean; onCreate: () => void;
  onOpen: (itemId: string) => void; onRetry: () => void; menuFor: (summary: CollectionItemSummary) => MenuItem[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CollectionFilter>("all");
  const list = useRef<HTMLUListElement>(null);
  const items = state.status === "ready" ? state.items : null;
  const sorted = useMemo(() => sortCollectionItems(items ?? [], definition.ordering), [items, definition.ordering]);
  const counts = useMemo(() => ({
    all: sorted.length,
    published: sorted.filter((item) => collectionItemFilter(item.status) === "published").length,
    draft: sorted.filter((item) => collectionItemFilter(item.status) === "draft").length,
  }), [sorted]);
  const needle = query.trim().toLocaleLowerCase("ja-JP");
  const visible = sorted.filter((item) => (filter === "all" || collectionItemFilter(item.status) === filter) &&
    (!needle || item.title.toLocaleLowerCase("ja-JP").includes(needle) || (item.path ?? "").toLocaleLowerCase("ja-JP").includes(needle)));
  const imageField = definition.fields.find((field) => field.key === definition.imageField);
  const shape = imageField?.type === "image" && imageField.shape === "round" ? "round" : "rect";
  useEffect(() => {
    if (!items || !focusItem) return;
    const target = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button.cw-row-open") ?? []).find((node) => node.dataset.itemId === focusItem);
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused();
  }, [items, focusItem, onFocused]);
  const tabs: readonly [CollectionFilter, string][] = [["all", "すべて"], ["published", "公開中"], ["draft", "下書き"]];
  return <div className="cw-list">
    <header className="cw-list-head">
      <div className="cw-list-title"><h2>{definition.label}</h2>{items && <span className="cw-count">{items.length} 件</span>}</div>
      <div className="cw-list-actions">
        <label className="cw-search"><Icon name="search" /><span className="cw-sr">題名で検索</span>
          <input type="search" value={query} placeholder="題名で検索" autoComplete="off" onChange={(event) => setQuery(event.target.value)} /></label>
        {canCreate && <button type="button" className="cw-button cw-primary" onClick={onCreate} disabled={creating}><Icon name="plus" />{creating ? "作っています…" : definition.addLabel}</button>}
      </div>
    </header>
    {state.status !== "ready" ? <Notice status={state.status} noun={definition.label} retry={onRetry} /> : <>
      <div className="cw-filters" role="group" aria-label="状態で絞り込む">{tabs.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
        {label}<span className="cw-filter-count"><span className="cw-sr">（</span>{counts[value]}<span className="cw-sr"> 件）</span></span></button>)}</div>
      {sorted.length === 0 ? <div className="cw-empty"><p>まだありません。</p>{canCreate && <button type="button" className="cw-button" onClick={onCreate} disabled={creating}><Icon name="plus" />{definition.addLabel}</button>}</div>
        : visible.length === 0 ? <div className="cw-empty"><p>{needle ? `「${query.trim()}」に当てはまる${definition.label}はありません。` : `${tabs.find(([value]) => value === filter)?.[1]}の${definition.label}はありません。`}</p>
          <button type="button" className="cw-button" onClick={() => { setQuery(""); setFilter("all"); }}>絞り込みをやめる</button></div>
        : <>
          <p className="cw-sr" role="status">{visible.length} 件を表示しています</p>
          <div className="cw-rows-head" aria-hidden="true"><span>題名</span><span>状態</span><span>公開日時</span><span>最終更新</span><span /></div>
          <ul className="cw-rows" ref={list} aria-label={`${definition.label}の一覧`}>{visible.map((item) => {
            const sub = item.subtitle ?? item.path;
            return <li className="cw-row" key={item.id}>
              <button type="button" className="cw-row-open" data-item-id={item.id} onClick={() => onOpen(item.id)}>
                <span className="cw-thumb" data-shape={shape}><Thumb src={imageSrc(item.imageUrl, 160)} /></span>
                <span className="cw-row-text"><span className="cw-row-title">{item.title || "無題"}</span>{sub && <span className="cw-row-sub">{sub}</span>}</span>
              </button>
              <span className="cw-row-meta">
                <span className="cw-cell cw-cell-status"><span className="cw-cell-label">状態</span><StatusBadges status={item.status} scheduledAt={item.scheduledAt} publishFailed={item.publishFailed} timeZone={timeZone} /></span>
                <span className="cw-cell cw-cell-published"><span className="cw-cell-label">公開</span><DateTime value={item.publishedAt} timeZone={timeZone} /></span>
                <span className="cw-cell cw-cell-updated"><span className="cw-cell-label">最終更新</span><DateTime value={item.updatedAt} timeZone={timeZone} />{item.updatedBy && <span className="cw-by">{item.updatedBy}</span>}</span>
              </span>
              <MenuButton label={`「${item.title || "無題"}」の操作`} items={menuFor(item)} className="cw-row-menu" />
            </li>;
          })}</ul>
        </>}
    </>}
  </div>;
}

/* ---------- 項目の編集 ---------- */

type SaveState = "idle" | "pending" | "saving" | "saved" | "error" | "invalid";
type FieldErrors = Readonly<Record<string, { readonly message: string; readonly source: "local" | "server" }>>;
type EditorProps = {
  adapter: CollectionAdapter; definition: CollectionDefinition; itemId: string; created: CollectionItem | null; timeZone: string; autosaveDelay: number;
  renderRichText: ((props: CollectionRichTextEditorProps) => ReactNode) | undefined;
  references: (collectionId: string) => ReferenceCandidates; retryReferences: (collectionId: string) => void;
  confirm: (request: ConfirmRequest) => void;
  onSaved: (item: CollectionItem) => void; onBack: () => void; onRemoved: (message: string) => void; onOpenItem: (item: CollectionItem) => void;
};
type Live = {
  item: CollectionItem | null; values: CollectionValues; dirty: boolean; seq: number; saving: Promise<boolean> | null;
  timer: ReturnType<typeof setTimeout> | undefined; blocked: boolean; closed: boolean; uploads: Set<Promise<unknown>>;
};

function safeLink(value: string | null): string | null {
  if (value === null) return null;
  return isDisplayableImageUrl(value) ? value : null;
}

function ItemEditor({ adapter, definition, itemId, created, timeZone, autosaveDelay, renderRichText, references, retryReferences, confirm, onSaved, onBack, onRemoved, onOpenItem }: EditorProps) {
  const requests = useRequests();
  const baseId = useId();
  const root = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null), scheduleField = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<"loading" | "error" | "forbidden" | "not_found" | "ready">(created ? "ready" : "loading");
  const [item, setItemState] = useState<CollectionItem | null>(created);
  const [values, setValuesState] = useState<CollectionValues>(created?.values ?? {});
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [general, setGeneral] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ readonly text: string; readonly error: boolean } | null>(null);
  const [scheduleInput, setScheduleInput] = useState("");
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const live = useRef<Live>({ item: created, values: created?.values ?? {}, dirty: false, seq: 0, saving: null, timer: undefined, blocked: false, closed: false, uploads: new Set() });

  const setItem = (next: CollectionItem) => { live.current.item = next; setItemState(next); onSaved(next); };
  const resetTo = (next: CollectionItem) => {
    const s = live.current;
    clearTimeout(s.timer);
    Object.assign(s, { item: next, values: next.values, dirty: false, blocked: false, seq: s.seq + 1 });
    setItemState(next); setValuesState(next.values); setDirty(false); setConflict(false); setErrors({}); setGeneral([]); setSaveState("idle");
    onSaved(next);
  };
  const lose = (status: "forbidden" | "not_found") => {
    const s = live.current;
    clearTimeout(s.timer);
    Object.assign(s, { item: null, values: {}, dirty: false, blocked: true });
    setItemState(null); setValuesState({}); setDirty(false); setBanner(null); setPhase(status);
  };
  const showProblems = (problems: readonly CollectionFieldError[], source: "local" | "server", focus: boolean) => {
    const known = new Set(definition.fields.map((field) => field.key));
    const next: Record<string, { message: string; source: "local" | "server" }> = {}, rest: string[] = [];
    for (const problem of problems) {
      if (!known.has(problem.field)) rest.push(problem.message);
      else if (!next[problem.field]) next[problem.field] = { message: problem.message, source };
    }
    setErrors(next);
    setGeneral(rest);
    const first = definition.fields.find((field) => next[field.key]);
    if (focus && first) focusField(first.key);
  };
  const focusField = (key: string) => {
    const target = document.getElementById(fieldControlId(baseId, key)) ?? root.current?.querySelector<HTMLElement>(`[data-field="${key}"] :is(input,textarea,button,[contenteditable])`);
    target?.focus();
    target?.scrollIntoView?.({ block: "center" });
  };

  const load = async () => {
    setPhase("loading");
    const outcome = await requests.current.run(async (signal) => parseCollectionItemResult(await adapter.loadItem({ collectionId: definition.id, itemId }, signal), definition, itemId));
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "error") { setPhase("error"); return; }
    if (outcome.value.status !== "ready") { lose(outcome.value.status); return; }
    resetTo(outcome.value.item);
    setPhase("ready");
  };
  useEffect(() => {
    const s = live.current;
    s.closed = false;
    if (!created) void load();
    return () => { s.closed = true; clearTimeout(s.timer); };
    // 開いたときに 1 回だけ読む（key で項目ごとに作り直す）
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      const s = live.current;
      if (s.dirty || s.saving || s.uploads.size) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  const focused = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || focused.current) return;
    focused.current = true;
    if (created) focusField(definition.titleField);
    else heading.current?.focus();
  }, [phase]);

  /* ---------- 保存（下書き・自動） ---------- */
  const save = async (): Promise<boolean> => {
    const s = live.current;
    clearTimeout(s.timer);
    s.timer = undefined;
    if (s.closed || !s.item) return false;
    if (s.saving) {
      if (!(await s.saving)) return false;
      return s.dirty ? save() : true;
    }
    if (s.blocked) return false;
    if (!s.dirty) return true;
    const seq = s.seq, values = s.values, version = s.item.version;
    setSaveState("saving");
    const task = (async (): Promise<boolean> => {
      try {
        const outcome = await requests.current.run(async (signal) => parseCollectionSaveResult(await adapter.saveDraft({ collectionId: definition.id, itemId, version, values }, signal), definition, itemId));
        if (outcome.kind === "aborted") return false;
        if (outcome.kind === "error") { setSaveState("error"); return false; }
        const result = outcome.value;
        if (result.status === "saved") {
          setItem(result.item);
          if (s.seq === seq) { s.dirty = false; setDirty(false); }
          setErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([, error]) => error.source === "local")));
          setGeneral([]);
          setSaveState(s.dirty ? "pending" : "saved");
          return true;
        }
        if (result.status === "conflict") { s.blocked = true; setConflict(true); setSaveState("error"); return false; }
        if (result.status === "invalid") { showProblems(result.errors, "server", false); setSaveState("invalid"); return false; }
        lose(result.status);
        return false;
      } finally { s.saving = null; }
    })();
    s.saving = task;
    return task;
  };
  /** 上げている画像と保存待ちを済ませる。保存できなければ false。 */
  const flush = async (): Promise<boolean> => {
    const s = live.current;
    clearTimeout(s.timer);
    while (s.uploads.size) await Promise.allSettled([...s.uploads]);
    for (let attempt = 0; attempt < 5 && (s.dirty || s.saving); attempt++) {
      if (!(await save())) return false;
    }
    return !s.dirty && !s.blocked && !!s.item;
  };
  const change = (key: string, value: CollectionValue) => {
    const s = live.current;
    if (!s.item) return;
    s.values = { ...s.values, [key]: value };
    s.dirty = true;
    s.seq++;
    setValuesState(s.values);
    setDirty(true);
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    if (s.blocked) return;
    setSaveState("pending");
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { void save(); }, autosaveDelay);
  };

  /* ---------- 公開・予約・ほかの操作 ---------- */
  const titleText = () => { const value = live.current.values[definition.titleField]; return typeof value === "string" && value.trim() ? value.trim() : "無題"; };
  const publish = async () => {
    const s = live.current;
    if (busy || !s.item || s.blocked) return;
    const problems = validateCollectionValues(definition, s.values);
    if (problems.length) { showProblems(problems, "local", true); setBanner({ text: "公開できません。印のついた項目を直してください。", error: true }); return; }
    setBusy("publish");
    setBanner(null);
    try {
      if (!(await flush())) { if (!s.blocked && s.item) setBanner({ text: "保存できないため、公開しませんでした。", error: true }); return; }
      const version = s.item!.version;
      const outcome = await requests.current.run(async (signal) => parseCollectionPublishResult(await adapter.publish({ collectionId: definition.id, itemId, version }, signal), definition, itemId));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "公開できませんでした。もう一度試してください。", error: true }); return; }
      const result = outcome.value;
      if (result.status === "published" || result.status === "publishing") {
        setItem(result.item);
        setBanner({ text: result.status === "publishing" ? "公開しました。サイトに出るまで少しかかります。" : "公開しました。", error: false });
      } else if (result.status === "conflict") { s.blocked = true; setConflict(true); }
      else if (result.status === "invalid") { showProblems(result.errors, "server", true); setBanner({ text: "公開できません。印のついた項目を直してください。", error: true }); }
      else lose(result.status);
    } finally { setBusy(null); }
  };
  /** 保存の結果（saved）を返す操作。keepEdits が false なら、まだ保存していない変更を捨てる。 */
  const mutate = async (kind: string, call: (version: string, signal: AbortSignal) => Promise<unknown>, success: string, keepEdits: boolean): Promise<boolean> => {
    const s = live.current;
    if (!s.item) return false;
    setBusy(kind);
    setBanner(null);
    try {
      if (keepEdits) {
        if (!(await flush())) { if (!s.blocked && s.item) setBanner({ text: "保存できないため、操作しませんでした。", error: true }); return false; }
      } else {
        clearTimeout(s.timer);
        if (s.saving) await s.saving;
      }
      if (!s.item) return false;
      const version = s.item.version;
      const outcome = await requests.current.run(async (signal) => parseCollectionSaveResult(await call(version, signal), definition, itemId));
      if (outcome.kind === "aborted") return false;
      if (outcome.kind === "error") { setBanner({ text: "操作できませんでした。もう一度試してください。", error: true }); return false; }
      const result = outcome.value;
      if (result.status === "saved") {
        if (keepEdits) setItem(result.item); else resetTo(result.item);
        setBanner({ text: success, error: false });
        return true;
      }
      if (result.status === "conflict") { s.blocked = true; setConflict(true); }
      else if (result.status === "invalid") { showProblems(result.errors, "server", true); setBanner({ text: "この操作はできません。印のついた項目を直してください。", error: true }); }
      else lose(result.status);
      return false;
    } finally { setBusy(null); }
  };
  const reloadLatest = async () => {
    setBusy("reload");
    try {
      const outcome = await requests.current.run(async (signal) => parseCollectionItemResult(await adapter.loadItem({ collectionId: definition.id, itemId }, signal), definition, itemId));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "読み込めませんでした。もう一度試してください。", error: true }); return; }
      if (outcome.value.status !== "ready") { lose(outcome.value.status); return; }
      resetTo(outcome.value.item);
      setBanner({ text: "最新の内容を読み込みました。", error: false });
    } finally { setBusy(null); }
  };
  const removeItem = async () => {
    const s = live.current;
    if (!s.item || !adapter.remove) return;
    setBusy("remove");
    try {
      clearTimeout(s.timer);
      if (s.saving) await s.saving;
      if (!s.item) return;
      const version = s.item.version;
      const outcome = await requests.current.run(async (signal) => parseCollectionRemoveResult(await adapter.remove!({ collectionId: definition.id, itemId, version }, signal), definition, itemId));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "削除できませんでした。もう一度試してください。", error: true }); return; }
      const result = outcome.value;
      if (result.status === "removed" || result.status === "not_found") {
        Object.assign(s, { dirty: false, blocked: true });
        onRemoved(result.status === "removed" ? "削除しました。" : "すでに削除されていました。");
      } else if (result.status === "conflict") { s.blocked = true; setConflict(true); }
      else lose(result.status);
    } finally { setBusy(null); }
  };
  const duplicate = async () => {
    if (!adapter.duplicate) return;
    setBusy("duplicate");
    try {
      if (!(await flush())) { if (!live.current.blocked && live.current.item) setBanner({ text: "保存できないため、複製しませんでした。", error: true }); return; }
      const outcome = await requests.current.run(async (signal) => parseCollectionCreateResult(await adapter.duplicate!({ collectionId: definition.id, itemId }, signal), definition));
      if (outcome.kind === "aborted") return;
      if (outcome.kind === "error") { setBanner({ text: "複製できませんでした。もう一度試してください。", error: true }); return; }
      if (outcome.value.status === "created") onOpenItem(outcome.value.item);
      else lose(outcome.value.status);
    } finally { setBusy(null); }
  };
  const scheduleIt = async () => {
    const schedule = adapter.schedule;
    if (!schedule) return;
    const at = collectionDateFromInput(scheduleInput, timeZone);
    if (!at || Date.parse(at) <= Date.now()) { setScheduleError("これから先の日時を選んでください。"); scheduleField.current?.focus(); return; }
    setScheduleError(null);
    const problems = validateCollectionValues(definition, live.current.values);
    if (problems.length) { showProblems(problems, "local", true); setBanner({ text: "予約できません。印のついた項目を直してください。", error: true }); return; }
    const done = await mutate("schedule", (version, signal) => schedule.call(adapter, { collectionId: definition.id, itemId, version, at }, signal), `予約しました。${formatDateTime(at, timeZone)}（${zoneLabel(timeZone)}）に公開します。`, true);
    if (done) setScheduleInput("");
  };
  const back = async () => {
    if (busy === "back") return;
    setBusy("back");
    const ok = await flush();
    setBusy(null);
    if (ok) { onBack(); return; }
    confirm({
      title: "保存できていない変更があります", body: "一覧へ戻ると、この画面でいま直したところは消えます。", confirmLabel: "変更を捨てて戻る", tone: "danger",
      run: () => { const s = live.current; clearTimeout(s.timer); Object.assign(s, { dirty: false, blocked: true }); onBack(); },
    });
  };

  if (phase !== "ready" || !item) {
    return <div className="cw-editor" ref={root}>
      <header className="cw-editor-bar"><button type="button" className="cw-back" onClick={onBack}><Icon name="back" /><span className="cw-back-label">一覧へ</span></button></header>
      {phase === "not_found" ? <div className="cw-notice"><p role="alert">この{definition.label}は見つかりませんでした。削除されたかもしれません。</p></div>
        : <Notice status={phase === "ready" ? "loading" : phase} noun={definition.label} retry={() => void load()} />}
    </div>;
  }

  const status: CollectionItemStatus = dirty && item.status === "published" ? "changed" : item.status;
  const capabilities = definition.capabilities;
  const menu: MenuItem[] = [];
  if (status === "changed" && adapter.discardDraft) menu.push({ label: "変更を取り消す", onSelect: () => confirm({
    title: "変更を取り消しますか？", body: "公開中の内容に戻ります。取り消した変更は元に戻せません。", confirmLabel: "変更を取り消す", tone: "danger",
    run: async () => { await mutate("discard", (version, signal) => adapter.discardDraft!({ collectionId: definition.id, itemId, version }, signal), "変更を取り消しました。公開中の内容に戻しました。", false); },
  }) });
  if (capabilities.unpublish && adapter.unpublish && (status === "published" || status === "changed")) menu.push({ label: "非公開にする", onSelect: () => confirm({
    title: `「${titleText()}」を非公開にしますか？`, body: "サイトから外れます。もう一度公開するまで、このアドレスは開けなくなります。", confirmLabel: "非公開にする", tone: "danger",
    run: async () => { await mutate("unpublish", (version, signal) => adapter.unpublish!({ collectionId: definition.id, itemId, version }, signal), "非公開にしました。サイトから外れるまで少しかかります。", true); },
  }) });
  if (capabilities.duplicate && adapter.duplicate) menu.push({ label: "複製する", onSelect: () => void duplicate() });
  if (capabilities.remove && adapter.remove) menu.push({ label: "削除する", danger: true, onSelect: () => confirm({
    title: `「${titleText()}」を削除しますか？`, body: status === "draft" ? "削除は元に戻せません。" : "サイトからも外れます。削除は元に戻せません。", confirmLabel: "削除する", tone: "danger",
    run: removeItem,
  }) });
  const primary = busy === "publish" ? { label: "公開しています…", disabled: true }
    : status === "published" ? { label: "公開中", disabled: true }
    : status === "publishing" && !dirty ? { label: "反映中", disabled: true }
    : { label: status === "changed" || status === "publishing" ? "変更を公開する" : "公開する", disabled: conflict || !!busy };
  const saveText = saveState === "pending" || saveState === "saving" ? "保存中…" : saveState === "saved" ? "保存しました"
    : saveState === "invalid" ? "保存できませんでした（直すところがあります）" : saveState === "error" ? conflict ? "保存していません" : "保存できませんでした" : "";
  let preview: string | null = null;
  try { preview = adapter.previewUrl ? safeLink(adapter.previewUrl(definition.id, item)) : null; } catch { preview = null; }
  const slugValue = definition.slugField ? values[definition.slugField] : null;
  const address = definition.pathPrefix !== null && definition.slugField !== null
    ? typeof slugValue === "string" && slugValue.trim() ? `${definition.pathPrefix}${slugValue.trim()}` : null
    : item.path;
  const publishedSlug = item.publishedAt !== null && item.path !== null && definition.pathPrefix !== null && item.path.startsWith(definition.pathPrefix) ? item.path.slice(definition.pathPrefix.length) : null;
  const sanitize = (html: string) => sanitizeRichTextHtml(html, adapter.isRichTextImageAllowed ? { isImageSrcAllowed: (src) => adapter.isRichTextImageAllowed!(src) } : {});
  const upload: FieldContext["upload"] = async (file) => {
    const s = live.current;
    const task = requests.current.run(async (signal) => parseCollectionUploadResult(await adapter.uploadImage({ collectionId: definition.id, file }, signal)));
    s.uploads.add(task);
    try {
      const outcome = await task;
      if (outcome.kind !== "ok") return { error: rejectMessages.failed };
      if (outcome.value.status === "rejected") return { error: rejectMessages[outcome.value.reason] };
      const { url, width, height } = outcome.value;
      return { url, ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
    } finally { s.uploads.delete(task); }
  };
  const context: FieldContext = {
    baseId, timeZone, pathPrefix: definition.pathPrefix, isTitle: false, publishedSlug, self: { collectionId: definition.id, itemId },
    imageSrc: (url, width) => displayImage(url, width, adapter.imageUrl ? (value, size) => adapter.imageUrl!(value, size) : undefined),
    upload, references, retryReferences, renderRichText, sanitize,
  };
  const fieldNode = (field: CollectionDefinition["fields"][number]) => <FieldView key={field.key} field={field} value={values[field.key]} error={errors[field.key]?.message}
    context={field.key === definition.titleField ? { ...context, isTitle: true } : context} onChange={(value) => change(field.key, value)} />;
  const mainFields = definition.fields.filter((field) => field.placement === "main"), sideFields = definition.fields.filter((field) => field.placement === "side");
  const canSchedule = capabilities.schedule && !!adapter.schedule;

  return <div className="cw-editor" ref={root}>
    <h2 className="cw-sr" tabIndex={-1} ref={heading}>{`${definition.label}「${titleText()}」の編集`}</h2>
    <header className="cw-editor-bar">
      <button type="button" className="cw-back" onClick={() => void back()} disabled={busy === "back"}><Icon name="back" /><span className="cw-back-label">一覧へ</span></button>
      <div className="cw-editor-status">
        <StatusBadges status={status} scheduledAt={item.scheduledAt} publishFailed={item.publishFailed} timeZone={timeZone} />
        <span className="cw-save-state" role="status">{saveText}</span>
        {(saveState === "error" || saveState === "invalid") && !conflict && <button type="button" className="cw-link-button" onClick={() => void save()}>再試行</button>}
      </div>
      <div className="cw-editor-actions">
        {preview && <a className="cw-button" href={preview} target="_blank" rel="noopener noreferrer">プレビュー<span className="cw-sr">（新しいタブで開く）</span></a>}
        <MenuButton label="その他の操作" items={menu} />
        <button type="button" className="cw-button cw-primary" disabled={primary.disabled} onClick={() => void publish()}>{primary.label}</button>
      </div>
    </header>
    {conflict && <div className="cw-banner" data-tone="error" role="alert">
      <p><strong>ほかの人が先に保存しました。</strong>この画面の変更は保存していません。「最新を読み込む」と、ほかの人が保存した内容を開きます（この画面でいま直したところは消えます）。</p>
      <button type="button" className="cw-button" disabled={busy === "reload"} onClick={() => void reloadLatest()}>最新を読み込む</button>
    </div>}
    {banner && <div className="cw-banner" data-tone={banner.error ? "error" : "info"} role={banner.error ? "alert" : "status"}>
      <p>{banner.text}</p><button type="button" className="cw-icon-button" aria-label="知らせを閉じる" onClick={() => setBanner(null)}><Icon name="close" /></button>
    </div>}
    {general.length > 0 && <div className="cw-banner" data-tone="error" role="alert"><ul>{general.map((message) => <li key={message}>{message}</li>)}</ul></div>}
    <div className="cw-editor-body">
      <div className="cw-editor-main"><div className="cw-card">{mainFields.map(fieldNode)}</div></div>
      <aside className="cw-editor-side" aria-label={`${definition.label}の公開と設定`}>
        <section className="cw-side-section" aria-labelledby={`${baseId}-publish`}>
          <h3 id={`${baseId}-publish`}>公開</h3>
          <dl className="cw-facts">
            <div><dt>状態</dt><dd><StatusBadges status={status} scheduledAt={item.scheduledAt} publishFailed={item.publishFailed} timeZone={timeZone} /></dd></div>
            <div><dt>公開日時</dt><dd><DateTime value={item.publishedAt} timeZone={timeZone} empty="まだ公開していません" /></dd></div>
            <div><dt>最終更新</dt><dd><DateTime value={item.updatedAt} timeZone={timeZone} />{item.updatedBy && <span className="cw-by"> · {item.updatedBy}</span>}</dd></div>
            {(definition.slugField !== null || item.path !== null) && <div><dt>アドレス</dt><dd className="cw-address">{address ?? "まだ決まっていません"}</dd></div>}
          </dl>
          {canSchedule && (item.scheduledAt !== null
            ? <div className="cw-schedule"><p><strong>公開予定</strong> <time dateTime={item.scheduledAt}>{formatDateTime(item.scheduledAt, timeZone)}</time>（{zoneLabel(timeZone)}）</p>
              {adapter.cancelSchedule && <button type="button" className="cw-button" disabled={!!busy || conflict} onClick={() => void mutate("cancelSchedule", (version, signal) => adapter.cancelSchedule!({ collectionId: definition.id, itemId, version }, signal), "予約を取り消しました。", true)}>予約を取り消す</button>}</div>
            : <div className="cw-schedule">
              <label className="cw-label" htmlFor={`${baseId}-schedule`}>予約して公開する日時</label>
              <p className="cw-hint" id={`${baseId}-schedule-hint`}>{zoneLabel(timeZone)}で入力します。保存した下書きを、その日時に公開します。</p>
              <div className="cw-inline">
                <input ref={scheduleField} id={`${baseId}-schedule`} type="datetime-local" className="cw-input" value={scheduleInput}
                  aria-describedby={`${baseId}-schedule-hint${scheduleError ? ` ${baseId}-schedule-error` : ""}`} aria-invalid={scheduleError ? true : undefined}
                  onChange={(event) => { setScheduleInput(event.target.value); setScheduleError(null); }} />
                <button type="button" className="cw-button" disabled={!scheduleInput || !!busy || conflict} onClick={() => void scheduleIt()}>予約する</button>
              </div>
              {scheduleError && <p className="cw-error" id={`${baseId}-schedule-error`}><Icon name="alert" />{scheduleError}</p>}
            </div>)}
        </section>
        {sideFields.length > 0 && <section className="cw-side-section cw-side-fields" aria-label="項目">{sideFields.map(fieldNode)}</section>}
      </aside>
    </div>
  </div>;
}
