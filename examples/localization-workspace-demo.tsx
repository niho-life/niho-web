import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LocalizationItemWorkspace, LocalizationWorkspace, type LocalizationNavigationState } from "@niho/web/localization-workspace";
import { ALL_PERMISSIONS, createLocalizationMemory } from "./localization-workspace-memory.mjs";

// 公開できる架空のデータだけを使う。認証・本番 API・実在の人やサイトには接続しない。変更はこのタブのメモリだけ。
const presets = {
  owner: { label: "オーナー（公開・戻し・設定まで）", permissions: ALL_PERMISSIONS },
  editor: { label: "編集者（直す・確認済み・翻訳案）", permissions: ["edit", "review", "translate"] },
  viewer: { label: "見るだけ", permissions: [] as string[] },
} as const;
type Preset = keyof typeof presets;

const memory = createLocalizationMemory({
  firstRelease: new URLSearchParams(location.search).get("first") === "1",
  frameUrl: `${location.origin}/frame.html`,
  mediaBase: "/media",
  pageSize: 2,
  catalogRounds: 2,
  upload: async (file: File) => {
    const response = await fetch("/upload", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!response.ok) throw new Error("upload failed");
    return (await response.json() as { url: string }).url;
  },
});
export const localizationWorkspaceDemoMemory = memory;

function readLocation(): { itemKey?: string; view?: "settings" } {
  const params = new URLSearchParams(location.search);
  return { ...(params.get("item") ? { itemKey: params.get("item")! } : {}), ...(params.get("view") === "settings" ? { view: "settings" as const } : {}) };
}

function App() {
  const start = readLocation();
  const embedded = new URLSearchParams(location.search).get("embedded") === "1";
  const [preset, setPreset] = useState<Preset>("owner");
  const [generation, setGeneration] = useState(0);
  const [opened, setOpened] = useState<string | null>(start.itemKey ?? null);
  const [note, setNote] = useState("");
  const [blockersCleared, setBlockersCleared] = useState(false);
  const navigate = (state: LocalizationNavigationState) => {
    setOpened(state.itemKey);
    const params = new URLSearchParams(location.search);
    params.delete("item"); params.delete("view");
    if (state.itemKey) params.set("item", state.itemKey);
    else if (state.view === "settings") params.set("view", "settings");
    history.replaceState(null, "", params.size ? `?${params}` : location.pathname);
  };
  const firstTextUnit = () => {
    const item = memory.state.items.find((entry: { key: string }) => entry.key === opened);
    const unit = item?.units.find((entry: { kind: string }) => entry.kind === "text");
    return item && unit ? { item, unit } : null;
  };
  return <>
    <div className="demo-tools">
      <label>権限
        <select value={preset} onChange={(event) => {
          const next = event.target.value as Preset;
          memory.setPermissions([...presets[next].permissions]);
          setPreset(next);
          setGeneration(generation + 1);
          setNote(`${presets[next].label}として開き直しました。`);
        }}>{Object.entries(presets).map(([value, entry]) => <option key={value} value={value}>{entry.label}</option>)}</select>
      </label>
      <button type="button" onClick={() => {
        const target = firstTextUnit();
        if (!target) { setNote("先に 1 件を開いてください。"); return; }
        memory.externalEdit(target.item.key, target.unit.unitId, "Edited by someone else (demo)");
        setNote(`「${target.item.title}」の「${target.unit.label}」をほかの人が直したことにしました。次の自動保存で知らせが出ます。`);
      }}>開いている 1 件をほかの人が直したことにする</button>
      <button type="button" onClick={() => {
        const target = firstTextUnit();
        if (!target) { setNote("先に 1 件を開いてください。"); return; }
        memory.changeSource(target.item.key, target.unit.unitId, `${target.unit.source}（改）`);
        setNote(`「${target.item.title}」の「${target.unit.label}」の原文が変わったことにしました。`);
      }}>原文が変わったことにする</button>
      <label><input type="checkbox" checked={blockersCleared} onChange={(event) => {
        memory.setBlockers(event.target.checked ? [] : null);
        setBlockersCleared(event.target.checked);
      }} />公開できない理由を消す（公開の手順を試す）</label>
      {note && <span role="status">{note}</span>}
    </div>
    {embedded ? <LocalizationItemWorkspace key={generation} adapter={memory.adapter} itemKey={start.itemKey ?? "YWJvdXQ"}
      onBack={() => window.location.assign("/")} onOpenRelated={(itemKey) => window.location.assign(`/?embedded=1&item=${encodeURIComponent(itemKey)}`)}
      relatedPageLink={{ href: "/?item=aG9tZQ", label: "英語の詳細ページ" }} />
      : <LocalizationWorkspace key={generation} adapter={memory.adapter} {...(start.itemKey && generation === 0 ? { initialItemKey: start.itemKey } : {})}
        {...(start.view && generation === 0 ? { initialView: start.view } : {})} onNavigate={navigate} />}
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
