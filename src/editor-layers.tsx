import { useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { layerSearchMatches, projectLayers, visibleLayers, type LayerEntry, type LayerLabels } from "./layers.js";
import type { PageDocument } from "./types.js";

/** レイヤー行の図形。STUDIO のレイヤーパネルに合わせ、テキストは T、画像は左上を塗った四角、ボックスは四角、コンポーネント（配置した再利用部品）は紫のひし形。リストとセクションは niho-web の要素の種類を見分けるために加える。 */
export type LayerGlyphName = "text" | "image" | "list" | "section" | "box" | "part" | "block";
const sectionTags = new Set(["section", "header", "footer", "nav", "main", "aside", "article"]), listTags = new Set(["ul", "ol", "dl"]);
export function layerGlyphName(entry: Pick<LayerEntry, "kind" | "node">): LayerGlyphName {
  if (entry.kind === "instance") return "part";
  if (entry.kind === "component") return "block";
  if (entry.kind === "image" || entry.kind === "text") return entry.kind;
  const tag = entry.node.type === "element" ? entry.node.tag : "";
  return listTags.has(tag) ? "list" : sectionTags.has(tag) ? "section" : "box";
}
const solid = { fill: "currentColor", stroke: "none" };
const layerGlyphs: Record<LayerGlyphName, ReactNode> = {
  text: <path d="M3.5 4h9M8 4v8.5M6 12.5h4" />,
  image: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.3" /><path d="M3.3 3.3h9L3.3 12.3z" {...solid} /></>,
  list: <><path d="M6 4.3h7M6 8h7M6 11.7h7" /><circle cx="3.2" cy="4.3" r=".9" {...solid} /><circle cx="3.2" cy="8" r=".9" {...solid} /><circle cx="3.2" cy="11.7" r=".9" {...solid} /></>,
  section: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.3" /><path d="M2.5 6.2h11" /></>,
  box: <rect x="2.5" y="2.5" width="11" height="11" rx="1.3" />,
  part: <path d="m8 2.3 5.7 5.7L8 13.7 2.3 8z" />,
  block: <><path d="m8 2.3 5.7 5.7L8 13.7 2.3 8z" /><circle cx="8" cy="8" r="1.4" {...solid} /></>
};
function LayerGlyph({ name }: { name: LayerGlyphName }) {
  return <svg className="e-layer-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{layerGlyphs[name]}</svg>;
}
function Chevron({ open }: { open: boolean }) {
  return <svg className={`e-layer-chevron${open ? " is-open" : ""}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 4.5 3.5 3.5L6 11.5" /></svg>;
}

export type LayerTreePanelProps = {
  document: PageDocument;
  labels?: LayerLabels;
  rootLabel: string;
  selectedId: string | null;
  selectedIds?: readonly string[];
  selectionVersion?: number;
  active?: boolean;
  disabled?: boolean;
  draggable?: boolean;
  canRename?: (entry: LayerEntry) => boolean;
  rename?: (id: string, value: string | undefined) => string | undefined;
  trailing?: (entry: LayerEntry) => ReactNode;
  className?: (entry: LayerEntry) => string;
  select: (id: string | null, mode?: "replace" | "toggle" | "range", rangeIds?: readonly string[]) => void;
  dragStart?: (event: DragEvent<HTMLElement>, id: string) => void;
  dragEnd?: () => void;
  dragOver?: (event: DragEvent<HTMLElement>, id: string) => void;
  drop?: (event: DragEvent<HTMLElement>, id: string) => void;
};

const rowHeight = 34, overscan = 4, initialViewportHeight = 408;

function ancestors(byId: ReadonlyMap<string, LayerEntry>, id: string | null): string[] {
  const result: string[] = [];
  let parent = id === null ? null : byId.get(id)?.parentId ?? null;
  while (parent !== null) { result.push(parent); parent = byId.get(parent)?.parentId ?? null; }
  return result;
}

/** ID を正本にした、折りたたみ・keyboard・DnD 共通レイヤーツリー。 */
export function LayerTreePanel({
  document, labels, rootLabel, selectedId, selectedIds = selectedId ? [selectedId] : [], selectionVersion,
  active = true, disabled = false, draggable = false, canRename, rename, trailing, className, select,
  dragStart, dragEnd, dragOver, drop
}: LayerTreePanelProps) {
  const entries = useMemo(() => projectLayers(document, labels), [document, labels]);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const selectedAncestors = ancestors(byId, selectedId).join("/");
  const [expanded, setExpanded] = useState(() => new Set(ancestors(byId, selectedId)));
  const [focusId, setFocusId] = useState<string | null>(selectedId);
  const [query, setQuery] = useState(""), [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<{ id: string; value: string; error?: string } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0), [viewportHeight, setViewportHeight] = useState(initialViewportHeight);
  const viewport = useRef<HTMLDivElement>(null), renameInput = useRef<HTMLInputElement>(null);
  const buttons = useRef(new Map<string | null, HTMLButtonElement>());
  const anchorId = useRef<string | null>(selectedId);
  const pendingFocus = useRef<{ id: string | null } | null>(null);
  const hadRowFocus = useRef(false);
  const lastRevealRequest = useRef<{ active: boolean; selectedId: string | null; selectedIndex: number | undefined; selectionVersion: number | undefined; search: string; viewportHeight: number } | null>(null);

  const search = query.trim();
  const matches = useMemo(() => layerSearchMatches(entries, search), [entries, search]);
  const { shown, searchParents } = useMemo(() => {
    if (!search) return { shown: entries, searchParents: new Set<string>() };
    const included = new Set(matches);
    if (selectedId !== null) included.add(selectedId);
    const parents = new Set<string>();
    for (const id of included) {
      const parent = byId.get(id)?.parentId;
      if (parent != null) { included.add(parent); parents.add(parent); }
    }
    return { shown: entries.filter(({ id }) => included.has(id)), searchParents: parents };
  }, [search, matches, selectedId, entries, byId]);
  const isBranch = (entry: LayerEntry) => search ? searchParents.has(entry.id) : entry.hasChildren;
  const open = useMemo(() => search ? new Set([...searchParents].filter((id) => !searchCollapsed.has(id))) : expanded,
    [search, searchParents, searchCollapsed, expanded]);
  const visible = useMemo(() => visibleLayers(shown, open), [shown, open]);
  const order = useMemo(() => [null, ...visible.map(({ id }) => id)], [visible]);
  const indexes = useMemo(() => new Map(order.map((id, index) => [id, index])), [order]);
  const children = useMemo(() => {
    const byParent = new Map<string | null, string[]>();
    const position = new Map<string, number>();
    for (const { id, parentId } of shown) {
      const siblings = byParent.get(parentId) ?? [];
      siblings.push(id);
      byParent.set(parentId, siblings);
      position.set(id, siblings.length);
    }
    return { byParent, position };
  }, [shown]);
  const visibleFocusId = [focusId, ...ancestors(byId, focusId)].find((id) => indexes.has(id)) ?? null;
  const selectedIndex = indexes.get(selectedId);
  const focusIndex = indexes.get(visibleFocusId) ?? 0;
  const renameEntry = draft ? byId.get(draft.id) : undefined;
  const renameId = active && !disabled && draft && renameEntry && indexes.has(draft.id) && canRename?.(renameEntry) && rename ? draft.id : null;
  const height = order.length * rowHeight;
  const toScrollTop = Math.max(0, Math.min(scrollTop, height - viewportHeight));
  const first = Math.max(0, Math.floor(toScrollTop / rowHeight) - overscan);
  const end = Math.min(order.length, Math.ceil((toScrollTop + viewportHeight) / rowHeight) + overscan);
  const rendered = new Set(Array.from({ length: end - first }, (_, offset) => first + offset));
  // スクロールしてもフォーカス、編集中の入力欄、ドラッグ元を DOM に残す。
  rendered.add(focusIndex);
  if (renameId !== null) rendered.add(indexes.get(renameId)!);
  if (draggedId !== null) {
    const draggedIndex = indexes.get(draggedId);
    if (draggedIndex !== undefined) rendered.add(draggedIndex);
  }

  function reveal(index: number) {
    const element = viewport.current;
    if (!active || !element) return;
    const available = element.clientHeight || viewportHeight;
    const start = index * rowHeight;
    const next = Math.min(element.scrollTop, start);
    const top = Math.max(0, Math.min(height - available, Math.max(next, start + rowHeight - available)));
    if (element.scrollTop !== top) element.scrollTop = top;
    setScrollTop(top);
  }

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!active || !element) return;
    const measure = () => {
      setViewportHeight(element.clientHeight || initialViewportHeight);
      setScrollTop(element.scrollTop);
    };
    measure();
    const Observer = element.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);

  useLayoutEffect(() => {
    const parents = selectedAncestors ? selectedAncestors.split("/") : [];
    setExpanded((current) => parents.every((id) => current.has(id)) ? current : new Set([...current, ...parents]));
    setSearchCollapsed((current) => parents.some((id) => current.has(id)) ? new Set([...current].filter((id) => !parents.includes(id))) : current);
    if (hadRowFocus.current) pendingFocus.current = { id: selectedId };
    setFocusId(selectedId);
  }, [selectedId, selectedAncestors, selectionVersion]);

  useLayoutEffect(() => {
    if (!selectedId) { if (!selectedIds.length) anchorId.current = null; return; }
    if (!selectedIds.includes(anchorId.current ?? "")) anchorId.current = selectedId;
  }, [selectedId, selectedIds]);

  useLayoutEffect(() => {
    const previous = lastRevealRequest.current;
    if (previous && previous.active === active && previous.selectedId === selectedId && (previous.selectedIndex === undefined) === (selectedIndex === undefined)
      && previous.selectionVersion === selectionVersion && previous.search === search && previous.viewportHeight === viewportHeight) return;
    lastRevealRequest.current = { active, selectedId, selectedIndex, selectionVersion, search, viewportHeight };
    if (selectedIndex !== undefined) reveal(selectedIndex);
  }, [active, selectedId, selectedIndex, selectionVersion, search, height, viewportHeight]);

  useLayoutEffect(() => {
    if (draft && renameId === null) setDraft(null);
  }, [draft, renameId]);
  useLayoutEffect(() => {
    if (renameId === null) return;
    renameInput.current?.focus({ preventScroll: true });
    renameInput.current?.select();
  }, [renameId]);
  useLayoutEffect(() => {
    if (!active || renameId !== null) return;
    const requested = pendingFocus.current;
    // 行が展開・再描画された後でフォーカスする。削除・検索で消えた場合は表示中の祖先へ戻る。
    if (!requested && (focusId === visibleFocusId || !hadRowFocus.current)) return;
    if (requested?.id && requested.id === selectedId && !indexes.has(requested.id) && byId.has(requested.id)) return;
    const id = requested && indexes.has(requested.id) ? requested.id : visibleFocusId;
    const button = buttons.current.get(id);
    if (!button) return;
    pendingFocus.current = null;
    reveal(indexes.get(id) ?? 0);
    button.focus({ preventScroll: true });
  });

  function focus(id: string | null) {
    setFocusId(id);
    const index = indexes.get(id);
    if (index !== undefined) reveal(index);
    const button = buttons.current.get(id);
    if (button) button.focus({ preventScroll: true });
    else pendingFocus.current = { id };
  }
  function toggle(id: string, value = !open.has(id)) {
    if (!value && ancestors(byId, selectedId).includes(id)) { select(id); focus(id); }
    const update = (current: Set<string>, include: boolean) => {
      const next = new Set(current);
      if (include) next.add(id);
      else next.delete(id);
      return next;
    };
    if (search) setSearchCollapsed((current) => update(current, !value));
    else setExpanded((current) => update(current, value));
  }
  function startRename(entry: LayerEntry) {
    if (disabled || !canRename?.(entry) || !rename) return false;
    setFocusId(entry.id);
    reveal(indexes.get(entry.id) ?? 0);
    setDraft({ id: entry.id, value: entry.node.name ?? "" });
    return true;
  }
  function endRename(id: string) {
    pendingFocus.current = { id };
    setDraft(null);
  }
  function keys(event: KeyboardEvent<HTMLElement>, entry: LayerEntry | null) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const id = entry?.id ?? null, index = indexes.get(id) ?? 0;
    if (event.key === "F2" && entry && startRename(entry)) { event.preventDefault(); return; }
    if (!["ArrowUp", "ArrowDown", "Home", "End", "ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowUp") focus(order[Math.max(0, index - 1)] ?? null);
    else if (event.key === "ArrowDown") focus(order[Math.min(order.length - 1, index + 1)] ?? null);
    else if (event.key === "Home") focus(null);
    else if (event.key === "End") focus(order.at(-1) ?? null);
    else if (event.key === "Enter" || event.key === " ") select(id);
    else if (event.key === "ArrowRight" && entry && isBranch(entry)) {
      if (open.has(entry.id)) focus(children.byParent.get(entry.id)?.[0] ?? entry.id);
      else toggle(entry.id, true);
    } else if (event.key === "ArrowLeft" && entry) {
      if (isBranch(entry) && open.has(entry.id)) toggle(entry.id, false);
      else focus(entry.parentId);
    }
  }

  function buttonRef(id: string | null, element: HTMLButtonElement | null) {
    if (element) buttons.current.set(id, element);
    else buttons.current.delete(id);
  }
  const selected = new Set(selectedIds);
  return <>
    <label className="e-field e-layer-search"><span>レイヤーを検索</span><input type="search" value={query} onChange={(event) => {
      setQuery(event.target.value);
      setSearchCollapsed(new Set());
      if (viewport.current) viewport.current.scrollTop = 0;
      setScrollTop(0);
    }} /></label>
    {search && matches.size === 0 && <p className="e-help" role="status">一致したレイヤーはありません。</p>}
    <div ref={viewport} className="e-layer-list" role="tree" aria-label="ページのレイヤー" aria-multiselectable="true" style={{ minHeight: Math.min(height, rowHeight * 2) }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onFocus={(event) => { hadRowFocus.current = (event.target as HTMLElement).getAttribute("role") === "treeitem"; }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) hadRowFocus.current = false; }}>
      <div className="e-layer-space" role="presentation" style={{ height }}>
        {[...rendered].sort((a, b) => a - b).map((index) => {
          const row = { top: index * rowHeight, height: rowHeight };
          const id = order[index];
          if (id == null) return <div key="root" role="presentation" data-layer-key="root" className="e-layer-row" style={row}>
            <button ref={(element) => buttonRef(null, element)} type="button" role="treeitem" aria-level={1} aria-posinset={1} aria-setsize={1} aria-selected={!selected.size}
              className="e-layer e-layer-root" aria-pressed={!selected.size} tabIndex={visibleFocusId === null ? 0 : -1} onFocus={() => setFocusId(null)}
              onClick={() => { setFocusId(null); anchorId.current = null; select(null); }} onKeyDown={(event) => keys(event, null)} disabled={disabled}>{rootLabel}</button>
          </div>;
          const entry = byId.get(id)!;
          const branch = isBranch(entry), opened = open.has(id);
          const glyph = layerGlyphName(entry), editing = renameId === id ? draft : null;
          const renameAvailable = !disabled && rename && canRename?.(entry);
          const semantics = {
            role: "treeitem", "aria-level": entry.depth + 2, "aria-selected": selected.has(id),
            "aria-posinset": children.position.get(id), "aria-setsize": children.byParent.get(entry.parentId)?.length,
            "aria-expanded": branch ? opened : undefined
          };
          return <div key={`node:${id}`} role="presentation" data-node-id={id} data-layer-kind={entry.kind} data-layer-glyph={glyph}
            className={`e-layer-row${className?.(entry) ?? ""}`} style={{ ...row, paddingLeft: entry.depth * 14 }} draggable={draggable && !editing}
            onDragStart={(event) => {
              if (!draggable || editing) return;
              dragStart?.(event, id);
              if (!event.defaultPrevented) setDraggedId(id);
            }}
            onDragEnd={() => { setDraggedId(null); dragEnd?.(); }}
            onDragOver={(event) => dragOver?.(event, id)} onDrop={(event) => { setDraggedId(null); drop?.(event, id); }}>
            {branch ? <button type="button" className="e-layer-toggle" aria-label={`${entry.label}を${opened ? "閉じる" : "開く"}`} tabIndex={-1} onClick={() => toggle(id)} disabled={disabled}><Chevron open={opened} /></button> : <span className="e-layer-toggle-placeholder" aria-hidden="true" />}
            {editing ? <div {...semantics} className="e-layer e-layer-rename" aria-label={entry.label}>
              <LayerGlyph name={glyph} />
              <input ref={renameInput} type="text" aria-label="要素の名前" aria-invalid={!!editing.error} value={editing.value} placeholder={entry.label}
                onChange={(event) => setDraft({ id, value: event.target.value })} onBlur={() => setDraft(null)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.key !== "Enter" && event.key !== "Escape") return;
                  event.preventDefault();
                  if (event.key === "Escape") { endRename(id); return; }
                  const error = rename?.(id, editing.value || undefined);
                  if (error) setDraft({ ...editing, error });
                  else endRename(id);
                }} />
            </div> : <button ref={(element) => buttonRef(id, element)} {...semantics} type="button" className="e-layer"
              aria-pressed={selected.has(id)} aria-keyshortcuts={renameAvailable ? "F2" : undefined}
              tabIndex={visibleFocusId === id ? 0 : -1} title={entry.label} onFocus={() => setFocusId(id)}
              onClick={(event) => {
                setFocusId(id);
                if (event.shiftKey) {
                  const from = indexes.get(anchorId.current ?? selectedId), to = indexes.get(id)!;
                  const range = from === undefined ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1).filter((value): value is string => value !== null);
                  select(id, "range", range);
                } else if (event.metaKey || event.ctrlKey) { anchorId.current = id; select(id, "toggle"); }
                else { anchorId.current = id; select(id, "replace"); }
              }} onKeyDown={(event) => keys(event, entry)} onDoubleClick={() => startRename(entry)} disabled={disabled}>
                <LayerGlyph name={glyph} /><span className="e-layer-label">{entry.label}</span>{trailing?.(entry)}
            </button>}
          </div>;
        })}
      </div>
    </div>
    {renameId !== null && draft?.error && <p className="e-help e-problem" role="alert">{draft.error}</p>}
  </>;
}
