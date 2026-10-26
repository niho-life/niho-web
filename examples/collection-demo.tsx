import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CollectionWorkspace, type CollectionNavigationState } from "@niho/web/collection-workspace";
import { LocalizationItemWorkspace } from "@niho/web/localization-workspace";
import { createStudioRichText } from "../studio/rich-text-editor.js";
import { studioRichTextCss } from "../studio/rich-text-style.js";
import { adapter, bodyListeners, demo, nextVersion, originalBodies, redirectListeners, store } from "./collection-memory.js";
import { createLocalizationMemory, seedItems } from "./localization-workspace-memory.mjs";

const translation = createLocalizationMemory({ catalogRounds: 2 });
const keyFor = (collectionId: string, itemId: string) => btoa(`cms:${collectionId}:${itemId}`).replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
const example = seedItems()[0];
translation.state.groups = [{ id: "cms", label: "CMS" }];
translation.state.items = Object.entries(store).flatMap(([collectionId, items]) => [...items.values()].map((item) => ({
  ...structuredClone(example), key: keyFor(collectionId, item.id), groupId: "cms", title: item.title || "無題", path: item.path,
  units: [{ ...structuredClone(example.units[0]), source: item.title || "無題", value: null, reviewedSource: null }],
})));

function readLocation(): { collectionId?: string; itemId?: string } {
  const params = new URLSearchParams(location.search), collectionId = params.get("c"), itemId = params.get("i");
  return { ...(collectionId ? { collectionId } : {}), ...(collectionId && itemId ? { itemId } : {}) };
}
let opened: CollectionNavigationState | null = null;
const tiptap = new URLSearchParams(location.search).get("rich") === "tiptap";
const renderRichText = tiptap ? createStudioRichText() : undefined;
const switchHref = (next: boolean) => { const params = new URLSearchParams(location.search); if (next) params.set("rich", "tiptap"); else params.delete("rich"); return `?${params}`; };

/** 開いている記事の本文が、読み込んだときからどう変わったか（保存した値で比べる）。 */
function BodyChange({ itemId }: { itemId: string | null }) {
  const [, setTick] = useState(0);
  useEffect(() => { const listener = () => setTick((tick) => tick + 1); bodyListeners.add(listener); return () => { bodyListeners.delete(listener); }; }, []);
  const original = itemId ? originalBodies.get(itemId) : undefined;
  if (original === undefined || !itemId) return <span>本文の値: 記事を開くと、読み込んだときとの違いを出します。</span>;
  const current = String(store.posts!.get(itemId)?.values.body ?? "");
  if (current === original) return <span role="status">本文の値: 読み込んだときと同じ（{original.length} 文字）</span>;
  let prefix = 0;
  while (prefix < original.length && original[prefix] === current[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < current.length - prefix && original[original.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix += 1;
  const around = (text: string) => text.length > 160 ? `${text.slice(0, 80)}…${text.slice(-60)}` : text;
  return <span role="status">本文の値: {prefix} 文字目から — 元「<code>{around(original.slice(prefix, original.length - suffix))}</code>」→ いま「<code>{around(current.slice(prefix, current.length - suffix))}</code>」（前後は同じ）</span>;
}

function App() {
  const start = readLocation();
  const [forbidden, setForbidden] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { redirectListeners.add(setNote); return () => { redirectListeners.delete(setNote); }; }, []);
  const [openItem, setOpenItem] = useState<string | null>(start.collectionId === "posts" ? start.itemId ?? null : null);
  const navigate = (state: CollectionNavigationState) => {
    opened = state;
    setOpenItem(state.collectionId === "posts" ? state.itemId ?? null : null);
    const params = new URLSearchParams({ c: state.collectionId, ...(state.itemId ? { i: state.itemId } : {}), ...(tiptap ? { rich: "tiptap" } : {}) });
    history.replaceState(null, "", `?${params}`);
  };
  const bump = () => {
    const target = opened ?? (start.collectionId && start.itemId ? { collectionId: start.collectionId, itemId: start.itemId } : null);
    const item = target?.itemId ? store[target.collectionId]?.get(target.itemId) : undefined;
    if (!item) { setNote("先に項目を開いてください。"); return; }
    item.version = nextVersion();
    item.updatedBy = "ほかの編集者（デモ）";
    setNote(`「${item.title || "無題"}」をほかの人が保存したことにしました。次の自動保存で知らせが出ます。`);
  };
  return <>
    {tiptap && <style dangerouslySetInnerHTML={{ __html: studioRichTextCss }} />}
    <div className="demo-tools">
      <a href={switchHref(!tiptap)} style={{ color: "inherit" }}>{tiptap ? "本文: TipTap（Studio の部品）→ 既定に戻す" : "本文: 既定 → TipTap（Studio の部品）にする"}</a>
      <button type="button" onClick={bump}>開いている項目をほかの人が保存したことにする</button>
      <label><input type="checkbox" checked={forbidden} onChange={(event) => { demo.forbidden = event.target.checked; setForbidden(event.target.checked); }} />権限を外す（次の読み書きから）</label>
      {note && <span role="status">{note}</span>}
      <BodyChange itemId={openItem} />
    </div>
    <CollectionWorkspace adapter={adapter} {...(renderRichText ? { renderRichText } : {})} {...(start.collectionId ? { initialCollectionId: start.collectionId } : {})} {...(start.itemId ? { initialItemId: start.itemId } : {})} onNavigate={navigate}
      itemLanguages={{ source: "日本語", target: "English", targetHref: ({ collectionId, itemId }) => `/translation-demo?item=${keyFor(collectionId, itemId)}`,
        renderTarget: ({ collectionId, itemId, onBack, registerBack }) => <LocalizationItemWorkspace adapter={translation.adapter} itemKey={keyFor(collectionId, itemId)} onBack={onBack} registerBack={registerBack} /> }} />
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
