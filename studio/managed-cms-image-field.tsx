import { useEffect, useRef, useState } from "react";
import { INSERTABLE_IMAGE_TYPES, assetKey, formatBytes, type AssetLibraryAdapter, type LibraryAsset, type ResolvedAssetMap } from "../src/assets.js";
import { COLLECTION_GALLERY_LIMIT, type CollectionGalleryEntry, type CollectionImageValue, type CollectionValue } from "../src/collection-model.js";
import type { AssetReference } from "../src/types.js";

const isReference = (value: unknown): value is AssetReference => !!value && typeof value === "object" && !Array.isArray(value)
  && typeof (value as AssetReference).provider === "string" && typeof (value as AssetReference).id === "string";

function useThumbnails(assets: AssetLibraryAdapter, siteId: string, references: readonly AssetReference[]): ResolvedAssetMap {
  const [resolved, setResolved] = useState<ResolvedAssetMap>({});
  const signature = JSON.stringify(references.map(assetKey));
  useEffect(() => {
    if (!references.length) { setResolved({}); return; }
    const controller = new AbortController();
    assets.resolveAssets({ siteId, references }, controller.signal).then(setResolved, () => { if (!controller.signal.aborted) setResolved({}); });
    return () => controller.abort();
    // references は signature で比較する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, siteId, signature]);
  return resolved;
}

const REJECTIONS = { type: "この形式の画像はアップロードできません。", size: "画像が大きすぎます（20 MiB まで）。", permission: "アップロードする権限がありません。",
  quota: "容量の上限に達しています。", scan: "画像を確認できませんでした。", invalid: "画像を受け付けられませんでした。" } as const;

/** 画像ライブラリから選ぶ、または新しくアップロードして選ぶ。 */
function AssetPickerDialog({ assets, siteId, onPick, onClose }: {
  assets: AssetLibraryAdapter; siteId: string; onPick: (asset: LibraryAsset) => void; onClose: () => void;
}) {
  const [items, setItems] = useState<readonly LibraryAsset[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [accept, setAccept] = useState<readonly string[]>(INSERTABLE_IMAGE_TYPES);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = (next: string | undefined, signal: AbortSignal) => assets.listAssets({ siteId, search: "", kind: "image", folderId: null, limit: 60, ...(next ? { cursor: next } : {}) }, signal)
    .then((result) => {
      setItems((previous) => next ? [...previous, ...result.assets] : result.assets);
      setCursor(result.nextCursor);
      if (result.upload) { setAccept(result.upload.accept); setMaxBytes(result.upload.maxBytes); }
      setState("ready");
    }, () => { if (!signal.aborted) setState("error"); });
  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, siteId]);
  const upload = async (file: File) => {
    // 送る前に形式と大きさを確かめる。大きな写真を全部送ってから断られないように。
    if (!accept.includes(file.type)) { setMessage(REJECTIONS.type); if (input.current) input.current.value = ""; return; }
    if (maxBytes !== null && file.size > maxBytes) { setMessage(REJECTIONS.size); if (input.current) input.current.value = ""; return; }
    setBusy(true); setMessage("");
    try {
      const result = await assets.uploadAsset({ siteId, folderId: null, file, name: file.name, mimeType: file.type, bytes: file.size }, new AbortController().signal);
      if (result.status === "uploaded") onPick(result.asset);
      else setMessage(REJECTIONS[result.reason]);
    } catch { setMessage("アップロードできませんでした。時間をおいて再度お試しください。"); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  return <div role="dialog" aria-modal="true" aria-label="画像を選ぶ" className="studio-cms-picker" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <div className="studio-site-hub-actions">
      <button type="button" disabled={busy} onClick={() => input.current?.click()}>{busy ? "アップロード中…" : "ファイルをアップロード"}</button>
      <button type="button" onClick={onClose}>閉じる</button>
      <input ref={input} type="file" hidden accept={accept.join(",")} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
    </div>
    {message && <p role="alert">{message}</p>}
    {state === "loading" && <p role="status">読み込んでいます…</p>}
    {state === "error" && <p role="alert">画像一覧を読み込めませんでした。</p>}
    {state === "ready" && !items.length && <p>画像はまだありません。アップロードしてください。</p>}
    <ul className="studio-cms-picker-grid">
      {items.filter((asset) => asset.kind === "image" && asset.status === "ready").map((asset) => <li key={assetKey(asset)}>
        <button type="button" onClick={() => onPick(asset)} title={asset.name}>
          {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : null}
          <span>{asset.name}</span>
          {asset.bytes > 0 && <small>{formatBytes(asset.bytes)}</small>}
        </button>
      </li>)}
    </ul>
    {cursor && <button type="button" onClick={() => void load(cursor, new AbortController().signal)}>さらに表示</button>}
  </div>;
}

function Thumbnail({ value, resolved }: { value: CollectionImageValue | null; resolved: ResolvedAssetMap }) {
  if (value === null) return <span className="studio-cms-image-empty">未選択</span>;
  if (typeof value === "string") return <span className="studio-cms-image-empty">{value}（移行前の URL）</span>;
  const src = resolved[assetKey(value)]?.src;
  return src ? <img className="studio-cms-image-preview" src={src} alt="" /> : <span className="studio-cms-image-empty">{value.id}</span>;
}

export function CmsImageField({ label, value, disabled, siteId, assets, update }: {
  label: string; value: CollectionValue; disabled: boolean; siteId: string; assets: AssetLibraryAdapter; update: (value: CollectionValue) => void;
}) {
  const [picking, setPicking] = useState(false);
  const current: CollectionImageValue | null = isReference(value) ? value : typeof value === "string" && value ? value : null;
  const resolved = useThumbnails(assets, siteId, isReference(current) ? [current] : []);
  return <fieldset className="studio-cms-image-field" disabled={disabled}>
    <legend>{label}</legend>
    <Thumbnail value={current} resolved={resolved} />
    <div className="studio-site-hub-actions">
      <button type="button" onClick={() => setPicking(true)}>{current === null ? "画像を選ぶ" : "画像を変更"}</button>
      {current !== null && <button type="button" onClick={() => update(null)}>画像を外す</button>}
    </div>
    {picking && <AssetPickerDialog assets={assets} siteId={siteId} onClose={() => setPicking(false)}
      onPick={(asset) => { update({ provider: asset.provider, id: asset.id }); setPicking(false); }} />}
  </fieldset>;
}

function newEntryId(): string { return `g${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`; }

export function CmsGalleryField({ label, captionLabel, value, disabled, siteId, assets, update }: {
  label: string; captionLabel: string; value: CollectionValue; disabled: boolean; siteId: string; assets: AssetLibraryAdapter;
  update: (value: CollectionValue) => void;
}) {
  const entries: readonly CollectionGalleryEntry[] = Array.isArray(value) ? (value as readonly CollectionGalleryEntry[]) : [];
  const [picking, setPicking] = useState<number | "add" | null>(null);
  const resolved = useThumbnails(assets, siteId, entries.flatMap(({ image }) => isReference(image) ? [image] : []));
  const replace = (index: number, entry: CollectionGalleryEntry) => update(entries.map((existing, i) => i === index ? entry : existing));
  const move = (index: number, offset: number) => {
    const next = [...entries], [moved] = next.splice(index, 1);
    next.splice(index + offset, 0, moved!);
    update(next);
  };
  return <fieldset className="studio-cms-image-field" disabled={disabled}>
    <legend>{label}</legend>
    <ol className="studio-cms-gallery">
      {entries.map((entry, index) => <li key={entry.id || `index-${index}`}>
        <Thumbnail value={entry.image} resolved={resolved} />
        <label>{captionLabel || "説明"} <input value={entry.caption} onChange={(event) => replace(index, { ...entry, caption: event.target.value })} /></label>
        <div className="studio-site-hub-actions">
          <button type="button" onClick={() => setPicking(index)}>画像を変更</button>
          <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>上へ</button>
          <button type="button" disabled={index === entries.length - 1} onClick={() => move(index, 1)}>下へ</button>
          <button type="button" onClick={() => update(entries.filter((_, i) => i !== index))}>削除</button>
        </div>
      </li>)}
    </ol>
    <div className="studio-site-hub-actions">
      <button type="button" disabled={entries.length >= COLLECTION_GALLERY_LIMIT} onClick={() => setPicking("add")}>画像を追加</button>
    </div>
    {picking !== null && <AssetPickerDialog assets={assets} siteId={siteId} onClose={() => setPicking(null)} onPick={(asset) => {
      const image = { provider: asset.provider, id: asset.id };
      if (picking === "add") update([...entries, { id: newEntryId(), image, caption: "" }]);
      else replace(picking, { ...entries[picking]!, image });
      setPicking(null);
    }} />}
  </fieldset>;
}
