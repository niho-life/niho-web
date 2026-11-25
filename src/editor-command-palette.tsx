"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "./editor-dialog.js";
import { editorShortcuts, type ShortcutAction, type ShortcutCommand } from "./editor-shortcuts.js";
import { layerSearchMatches, type LayerEntry } from "./layers.js";

type PaletteItem = { id: string; label: string; detail?: string | undefined; unavailable?: string | undefined; run: () => void };
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

export function CommandPalette({ commands, pages, layers, selectLayer, selectionUnavailable, close, report }: {
  commands: Record<ShortcutAction, ShortcutCommand>; pages: readonly PaletteItem[]; layers: readonly LayerEntry[];
  selectLayer: (entry: LayerEntry) => void; selectionUnavailable: string | undefined; close: () => void; report: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null), resultList = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const needle = normalize(query);
  const matches = (value: string) => normalize(value).includes(needle);
  const matchingLayers = layerSearchMatches(layers, needle);
  const groups: { label: string; items: readonly PaletteItem[] }[] = [
    { label: "操作", items: editorShortcuts.flatMap((shortcut) => {
      if (!("palette" in shortcut) || !matches(`${shortcut.label} ${shortcut.keyLabel}`)) return [];
      const command = commands[shortcut.action];
      return [{ id: shortcut.action, label: shortcut.label, detail: shortcut.keyLabel, unavailable: command.unavailable, run: () => {
        const result = command.run();
        if (typeof result === "string") report(result);
      } }];
    }) },
    { label: "ページ", items: pages.filter(({ label, detail }) => matches(`${label} ${detail ?? ""}`)) },
    { label: "要素", items: layers.filter(({ id }) => matchingLayers.has(id))
      .sort((a, b) => Number(matches(b.label)) - Number(matches(a.label)) || b.depth - a.depth)
      .map((entry) => ({ id: entry.id, label: entry.label, detail: layers.find((parent) => parent.id === entry.parentId)?.label,
        unavailable: selectionUnavailable, run: () => selectLayer(entry) })) },
  ];

  function moveFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
    if (!["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) return;
    const buttons = Array.from(resultList.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (event.key === "Enter" && event.target !== input.current) return;
    event.preventDefault();
    if (event.key === "Enter") { buttons[0]?.click(); return; }
    const index = buttons.findIndex((button) => button === event.target);
    if (event.key === "ArrowDown") buttons[index + 1]?.focus();
    else if (index === 0) input.current?.focus();
    else buttons[index < 0 ? buttons.length - 1 : index - 1]?.focus();
  }

  return <Dialog name="コマンドパレット" dismiss={close}>
    <h2>コマンドパレット</h2>
    <input ref={input} type="search" aria-label="ページ・要素・操作を検索" placeholder="ページ・要素・操作を検索" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={moveFocus} />
    <div className="e-command-results" ref={resultList} onKeyDown={moveFocus}>
      {groups.map(({ label, items }) => items.length > 0 && <section key={label} aria-label={label}><h3>{label}</h3><ul>
        {items.map((item) => <li key={item.id}><button type="button" disabled={!!item.unavailable} title={item.unavailable} onClick={() => { close(); item.run(); }}>
          <span>{item.label}</span>{item.detail && (label === "操作" ? <kbd>{item.detail}</kbd> : <small>{item.detail}</small>)}
        </button></li>)}
      </ul></section>)}
      {groups.every(({ items }) => !items.length) && <p className="e-help" role="status">一致する項目がありません。</p>}
    </div>
    <div className="e-actions"><button type="button" onClick={close}>閉じる</button></div>
  </Dialog>;
}
