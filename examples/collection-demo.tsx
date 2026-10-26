import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CollectionWorkspace, type CollectionAdapter, type CollectionDefinition, type CollectionItem, type CollectionNavigationState } from "@niho/web/collection-workspace";
import { createStudioRichText } from "../studio/rich-text-editor.js";
import { studioRichTextCss } from "../studio/rich-text-style.js";

// 公開できる架空のデータだけを使う。認証・本番 API・実在の人やサイトには接続しない。変更はこのタブのメモリだけ。
const now = () => new Date().toISOString();
const days = (offset: number) => new Date(Date.UTC(2026, 9, 26 + offset, 1)).toISOString();

const collections: CollectionDefinition[] = [
  {
    id: "posts", label: "記事", addLabel: "新しく書く", icon: "document", ordering: "publishedAt", pathPrefix: "/posts/",
    titleField: "title", slugField: "slug", imageField: "cover", subtitleField: null,
    capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: true, redirects: true, reorder: false, bulk: true, retrySchedule: true },
    fields: [
      { key: "title", label: "タイトル", type: "text", required: true, maxLength: 60, placement: "main" },
      { key: "cover", label: "カバー画像", type: "image", placement: "main", hint: "一覧のカードと、記事の上に出ます。" },
      { key: "body", label: "本文", type: "richText", placement: "main" },
      { key: "slug", label: "アドレス", type: "slug", required: true, placement: "side" },
      { key: "category", label: "カテゴリ", type: "reference", multiple: false, collectionId: "categories", placement: "side", hint: "一覧のカードの小さい文字に出ます。" },
      { key: "circles", label: "関わったサークル", type: "reference", multiple: true, collectionId: "circles", placement: "side" },
      { key: "keywords", label: "キーワード", type: "tags", placement: "side", hint: "記事の下にタグで出ます。" },
      { key: "kind", label: "種類", type: "select", multiple: false, options: [{ id: "news", label: "お知らせ" }, { id: "report", label: "レポート" }, { id: "column", label: "コラム" }], placement: "side" },
      { key: "eventAt", label: "開催日時", type: "datetime", placement: "side", hint: "催しの記事だけ。記事の上に出ます。" },
      { key: "source", label: "参考URL", type: "url", placement: "side" },
      { key: "description", label: "説明", type: "longText", rows: 3, maxLength: 120, placement: "side", hint: "検索結果と、共有したときのカードに出ます。" },
    ],
  },
  {
    id: "circles", label: "サークル", addLabel: "追加する", icon: "people", ordering: "manual", pathPrefix: "/circles/",
    titleField: "title", slugField: "slug", imageField: "photo", subtitleField: "host",
    capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: false, redirects: true, reorder: true, bulk: true, retrySchedule: false },
    fields: [
      { key: "title", label: "名前", type: "text", required: true, placement: "main" },
      { key: "photo", label: "カバー画像", type: "image", placement: "main", hint: "一覧のカードと、ページの上に出ます。" },
      { key: "summary", label: "活動の概要", type: "longText", rows: 3, placement: "main", hint: "一覧のカードに出ます。" },
      { key: "detail", label: "活動の詳細", type: "longText", rows: 7, placement: "main", hint: "ページの本文に出ます。" },
      { key: "works", label: "活動の写真", type: "gallery", captionLabel: "説明", placement: "main", maxItems: 6, captionMaxLength: 200, hint: "ページの下に並びます。" },
      { key: "hostPhoto", label: "主催者の顔写真", type: "image", shape: "round", placement: "main" },
      { key: "host", label: "主催者名", type: "text", placement: "side", hint: "一覧の題名の下に出ます。" },
      { key: "weekdays", label: "活動する曜日", type: "select", multiple: true, options: [{ id: "mon", label: "月" }, { id: "wed", label: "水" }, { id: "sat", label: "土" }, { id: "sun", label: "日" }], placement: "side" },
      { key: "categories", label: "カテゴリ", type: "reference", multiple: true, collectionId: "categories", placement: "side" },
      { key: "website", label: "ウェブサイト", type: "url", placement: "side" },
      { key: "slug", label: "アドレス", type: "slug", required: true, placement: "side" },
    ],
  },
  {
    id: "categories", label: "カテゴリ", addLabel: "追加する", icon: "tag", ordering: "manual", pathPrefix: null,
    titleField: "title", slugField: null, imageField: null, subtitleField: null,
    capabilities: { create: true, duplicate: false, remove: true, unpublish: false, schedule: false },
    fields: [
      { key: "title", label: "名前", type: "text", required: true, maxLength: 20, placement: "main" },
      { key: "note", label: "メモ", type: "longText", rows: 3, placement: "main", hint: "管理用。サイトには出ません。" },
    ],
  },
];

type Stored = { -readonly [K in keyof CollectionItem]: CollectionItem[K] } & { values: Record<string, unknown> };
const base = { subtitle: null, imageUrl: null, path: null, status: "draft" as const, publishedAt: null, updatedAt: days(-3), updatedBy: "デモ編集者", scheduledAt: null, publishFailed: false, order: null, version: "1" };
const store: Record<string, Map<string, Stored>> = { posts: new Map(), circles: new Map(), categories: new Map() };
const put = (collectionId: string, item: Stored) => store[collectionId]!.set(item.id, item);
let sequence = 1;
[["c-walk", "散歩"], ["c-learn", "学び"], ["c-event", "催し"]].forEach(([id, title], index) => put("categories", { ...base, id: id!, title: title!, status: "published", publishedAt: days(-30), order: index + 1, values: { title, note: "" } }));
put("circles", { ...base, id: "morning-yoga", title: "朝のヨガ部", subtitle: "架空の主催者 A", imageUrl: "/media/seed-green.svg", path: "/circles/morning-yoga", status: "published", publishedAt: days(-20), order: 1,
  values: { title: "朝のヨガ部", photo: "/media/seed-green.svg", summary: "週に 2 回、朝 7 時から体をほぐします。", detail: "はじめての人も歓迎です。", hostPhoto: "/media/seed-sand.svg", host: "架空の主催者 A", weekdays: ["wed", "sat"], categories: ["c-walk"], website: "", slug: "morning-yoga",
    works: [{ id: "w-1", image: "/media/seed-dusk.svg", caption: "海の見える広場で。" }, { id: "w-2", image: null, caption: "雨の日は公民館で。" }] } });
put("circles", { ...base, id: "board-games", title: "ボードゲームの会", subtitle: "架空の主催者 B", path: "/circles/board-games", status: "changed", publishedAt: days(-12), order: 2,
  values: { title: "ボードゲームの会", photo: null, summary: "月に 1 回、いろいろなゲームを持ち寄ります。", detail: "", hostPhoto: null, host: "架空の主催者 B", weekdays: ["sun"], categories: ["c-learn"], website: "https://example.test/games", slug: "board-games" } });
put("circles", { ...base, id: "draft-circle", title: "（準備中）写真さんぽ", subtitle: "架空の主催者 C", values: { title: "（準備中）写真さんぽ", photo: null, summary: "", detail: "", hostPhoto: null, host: "架空の主催者 C", weekdays: [], categories: [], website: "", slug: "photo-walk" } });
put("circles", { ...base, id: "garden", title: "花壇の手入れの会", subtitle: "架空の主催者 D", path: "/circles/garden", status: "published", publishedAt: days(-9), order: 3,
  values: { title: "花壇の手入れの会", photo: null, summary: "月に 2 回、駅前の花壇を手入れします。", detail: "", hostPhoto: null, host: "架空の主催者 D", weekdays: ["sat"], categories: ["c-walk"], website: "", slug: "garden" } });
put("posts", { ...base, id: "p-autumn", title: "秋の小さな市を開きました", imageUrl: "/media/seed-sand.svg", path: "/posts/autumn-market", status: "published", publishedAt: days(-5), updatedAt: days(-5),
  values: { title: "秋の小さな市を開きました", cover: "/media/seed-sand.svg", body: "<p>晴れた日曜日に、小さな市を開きました。</p><h2>当日のようす</h2><p>手づくりの品が<strong>20 店</strong>ならびました。</p><ul><li>焼き菓子</li><li>古本</li></ul>", slug: "autumn-market", category: ["c-event"], circles: ["board-games"], keywords: ["市", "秋"], kind: ["report"], eventAt: days(-6), source: "", description: "秋の小さな市のレポートです。" } });
put("posts", { ...base, id: "p-reading", title: "読書会の参加者を募集します", status: "changed", path: "/posts/reading", publishedAt: days(-2), updatedAt: days(-1), publishFailed: true,
  values: { title: "読書会の参加者を募集します", cover: null, body: "<p>毎月第 2 土曜日に読書会をしています。</p>", slug: "reading", category: ["c-learn"], circles: [], keywords: ["本"], kind: ["news"], eventAt: null, source: "", description: "" } });
put("posts", { ...base, id: "p-candle", title: "冬至のキャンドルの夜", status: "scheduled", scheduledAt: days(4), updatedAt: days(-1), publishFailed: true,
  values: { title: "冬至のキャンドルの夜", cover: "/media/seed-dusk.svg", body: "<p>灯りをともして、静かに過ごす夜です。</p>", slug: "candle-night", category: ["c-event"], circles: [], keywords: [], kind: ["news"], eventAt: days(30), source: "", description: "" } });
// STUDIO から移した形の本文（架空）。図の style・見出しの id（目次の飛び先）・目次の置き場・埋め込み・リンクの target を含む。
// ?rich=tiptap で開き、1 文字直して戻すと、下の「本文の値」で直した所以外が変わらないことを確かめられる。
const studioBody = '<h2 id="index_Dm8kQ2aL">はじめに</h2><p>架空の記事です。<a target="_blank" href="https://example.test/guide" rel="">案内のページ</a>もどうぞ。</p><div></div>'
  + '<figure style="text-align: "><img src="/media/seed-green.svg" alt="" width="" height=""><figcaption>架空の写真の説明</figcaption></figure>'
  + '<h3 id="index_Rt5vWx9P">当日の流れ</h3><p>午前は<strong>散歩</strong>、午後は<em>読書</em>でした。<br>二行目です。</p>'
  + '<figure style=""><img src="/media/seed-sand.svg" alt="" width="" height=""><figcaption></figcaption></figure>'
  + '<div data-type="embed_code"><iframe src="https://video.example.test/embed/demo" width="560" height="315" title="架空の動画" allowfullscreen=""></iframe></div>'
  + '<h2 id="index_Yh3nBc7Q">まとめ</h2><ul><li>ひとつめ</li><li>ふたつめ</li></ul><hr><p>おわり。<a target="_blank" href="#index_Dm8kQ2aL" rel="noopener">はじめにへ</a></p>';
put("posts", { ...base, id: "p-studio", title: "STUDIO から移した形の記事（架空）", imageUrl: "/media/seed-green.svg", path: "/posts/studio-shape", status: "published", publishedAt: days(-8), updatedAt: days(-8),
  values: { title: "STUDIO から移した形の記事（架空）", cover: "/media/seed-green.svg", body: studioBody, slug: "studio-shape", category: ["c-walk"], circles: [], keywords: ["移行"], kind: ["column"], eventAt: null, source: "", description: "本文の書式を保つかを確かめる架空の記事です。" } });
put("posts", { ...base, id: "p-draft", title: "", updatedAt: days(0), values: { title: "", cover: null, body: "", slug: "下書き", category: [], circles: [], keywords: [], kind: [], eventAt: null, source: "", description: "" } });

const demo = { forbidden: false, latencyMs: 250 };
// 転送はデモの外の仕事。画面が送った値をデモの帯に出して確かめられるようにする
const redirectListeners = new Set<(text: string) => void>();
const redirectNote = (text: string) => redirectListeners.forEach((listener) => listener(text));
// 本文の値の変化を見るため、読み込んだときの本文を覚えておき、保存のたびに知らせる
const originalBodies = new Map([...store.posts!.values()].map((item) => [item.id, String(item.values.body ?? "")]));
const bodyListeners = new Set<() => void>();
const copy = <T,>(value: T): T => structuredClone(value);
const summary = ({ version: _version, values: _values, ...rest }: Stored) => rest;
const delay = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, demo.latencyMs);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
});
const definitionOf = (collectionId: string) => collections.find((definition) => definition.id === collectionId)!;
function refresh(collectionId: string, item: Stored) {
  const definition = definitionOf(collectionId), values = item.values;
  item.title = String(values[definition.titleField] ?? "");
  item.imageUrl = definition.imageField ? (values[definition.imageField] as string | null) ?? null : null;
  if (definition.subtitleField) item.subtitle = String(values[definition.subtitleField] ?? "") || null;
  item.updatedAt = now();
  item.updatedBy = "あなた（デモ）";
  item.version = String(++sequence);
}
async function guarded<T>(signal: AbortSignal, run: () => T): Promise<T | { status: "forbidden" }> {
  await delay(signal);
  return demo.forbidden ? { status: "forbidden" } : run();
}
function versioned(input: { collectionId: string; itemId: string; version: string }, change: (item: Stored) => void) {
  const item = store[input.collectionId]?.get(input.itemId);
  if (!item) return { status: "not_found" };
  if (item.version !== input.version) return { status: "conflict", item: copy(item) };
  change(item);
  item.version = String(++sequence);
  item.updatedAt = now();
  return { status: "saved", item: copy(item) };
}
function finishPublishing(collectionId: string, itemId: string) {
  // デモでは「サイトの作り直し」を 4 秒で終える。一覧を開き直すと公開中になる。
  setTimeout(() => { const item = store[collectionId]?.get(itemId); if (item?.status === "publishing") item.status = "published"; }, 4000);
}

const adapter: CollectionAdapter = {
  loadSchema: (signal) => guarded(signal, () => ({ status: "ready", collections: copy(collections) })),
  listItems: ({ collectionId }, signal) => guarded(signal, () => ({ status: "ready", collectionId, items: [...store[collectionId]!.values()].map((item) => summary(copy(item))) })),
  loadItem: ({ collectionId, itemId }, signal) => guarded(signal, () => { const item = store[collectionId]?.get(itemId); return item ? { status: "ready", item: copy(item) } : { status: "not_found" }; }),
  saveDraft: (input, signal) => guarded(signal, () => {
    const item = store[input.collectionId]?.get(input.itemId);
    if (!item) return { status: "not_found" };
    if (item.version !== input.version) return { status: "conflict", item: copy(item) };
    const slugField = definitionOf(input.collectionId).slugField, slug = slugField ? input.values[slugField] : null;
    const taken = slugField && typeof slug === "string" && slug && [...store[input.collectionId]!.values()].some((other) => other.id !== item.id && other.values[slugField] === slug);
    if (taken) return { status: "invalid", errors: [{ field: slugField, message: "このアドレスはほかの項目が使っています。" }] };
    item.values = copy(input.values) as Record<string, unknown>;
    if (item.status === "published") item.status = "changed";
    refresh(input.collectionId, item);
    bodyListeners.forEach((listener) => listener());
    return { status: "saved", item: copy(item) };
  }),
  publish: (input, signal) => guarded(signal, () => {
    if (input.redirect !== undefined) redirectNote(`前のアドレスを${input.redirect ? "新しいアドレスへ移す" : "移さない"}で公開（デモ）`);
    const result = versioned(input, (item) => {
      const slugField = definitionOf(input.collectionId).slugField, prefix = definitionOf(input.collectionId).pathPrefix;
      Object.assign(item, { status: "publishing", publishedAt: item.publishedAt ?? now(), scheduledAt: null, publishFailed: false, path: prefix && slugField ? `${prefix}${String(item.values[slugField])}` : null });
    });
    if (result.status !== "saved") return result;
    finishPublishing(input.collectionId, input.itemId);
    return { ...result, status: "publishing" };
  }),
  discardDraft: (input, signal) => guarded(signal, () => versioned(input, (item) => { item.status = "published"; })),
  unpublish: (input, signal) => guarded(signal, () => versioned(input, (item) => Object.assign(item, { status: "draft", publishedAt: null, path: null }))),
  schedule: (input, signal) => guarded(signal, () => versioned(input, (item) => Object.assign(item, { status: item.publishedAt ? item.status : "scheduled", scheduledAt: input.at }))),
  cancelSchedule: (input, signal) => guarded(signal, () => versioned(input, (item) => Object.assign(item, { status: item.status === "scheduled" ? "draft" : item.status, scheduledAt: null }))),
  duplicate: ({ collectionId, itemId }, signal) => guarded(signal, () => {
    const from = store[collectionId]?.get(itemId);
    if (!from) return { status: "not_found" };
    const slugField = definitionOf(collectionId).slugField, id = `copy-${++sequence}`;
    const item: Stored = { ...copy(from), id, status: "draft", publishedAt: null, scheduledAt: null, path: null, publishFailed: false, order: null, version: "1",
      values: { ...copy(from.values), [definitionOf(collectionId).titleField]: `${from.title}（複製）`, ...(slugField ? { [slugField]: `${String(from.values[slugField] ?? "")}-copy` } : {}) } };
    refresh(collectionId, item);
    put(collectionId, item);
    return { status: "created", item: copy(item) };
  }),
  remove: (input, signal) => guarded(signal, () => {
    const item = store[input.collectionId]?.get(input.itemId);
    if (!item) return { status: "not_found" };
    if (item.version !== input.version) return { status: "conflict", item: copy(item) };
    // デモは転送を持たない。選んだ移動先をデモの帯に出すだけ
    if (input.redirectTo !== undefined) redirectNote(`削除した「${item.title || "無題"}」のアドレス ${item.path ?? ""} は ${input.redirectTo === null ? "移さない" : `${input.redirectTo} へ移す`}（デモ）`);
    store[input.collectionId]!.delete(input.itemId);
    return { status: "removed" };
  }),
  retrySchedule: (input, signal) => guarded(signal, () => versioned(input, (item) => { item.publishFailed = false; })),
  reorder: (input, signal) => guarded(signal, () => {
    const list = [...store[input.collectionId]!.values()];
    const current = list.filter((item) => item.order !== null).sort((a, b) => a.order! - b.order!).map((item) => item.id);
    if (current.join("\n") !== input.ids.join("\n")) return { status: "conflict", items: list.map((item) => summary(copy(item))) };
    const next = [...input.ids], [moved] = next.splice(input.from, 1);
    if (moved) next.splice(input.to, 0, moved);
    next.forEach((id, index) => { const item = store[input.collectionId]!.get(id)!; item.order = index + 1; item.version = String(++sequence); });
    return { status: "publishing", items: [...store[input.collectionId]!.values()].map((item) => summary(copy(item))) };
  }),
  bulk: (input, signal) => guarded(signal, () => {
    const map = store[input.collectionId]!;
    if (input.items.some(({ id, version }) => map.get(id)?.version !== version)) return { status: "conflict", items: [...map.values()].map((item) => summary(copy(item))) };
    if (input.action === "publish") {
      const slugField = definitionOf(input.collectionId).slugField;
      const blocked = input.items.map(({ id }) => map.get(id)!).filter((item) => slugField && !item.values[slugField]);
      if (blocked.length) return { status: "invalid", errors: blocked.map((item) => ({ field: "", message: `「${item.title || "無題"}」はアドレスが空なので公開できません。` })) };
    }
    for (const { id } of input.items) {
      const item = map.get(id)!, prefix = definitionOf(input.collectionId).pathPrefix, slugField = definitionOf(input.collectionId).slugField;
      if (input.action === "remove") map.delete(id);
      else if (input.action === "publish") { Object.assign(item, { status: "publishing", publishedAt: item.publishedAt ?? now(), scheduledAt: null, publishFailed: false, path: prefix && slugField ? `${prefix}${String(item.values[slugField])}` : null, version: String(++sequence) }); finishPublishing(input.collectionId, id); }
      else if (item.status === "published" || item.status === "changed" || item.status === "publishing") Object.assign(item, { status: "draft", publishedAt: null, path: null, version: String(++sequence) });
    }
    return { status: "publishing", items: [...map.values()].map((item) => summary(copy(item))) };
  }),
  createItem: ({ collectionId }, signal) => guarded(signal, () => {
    const definition = definitionOf(collectionId), id = `new-${++sequence}`;
    const values = Object.fromEntries(definition.fields.map((field) => [field.key, ["select", "reference", "tags", "gallery"].includes(field.type) ? [] : field.type === "image" || field.type === "datetime" ? null : ""]));
    const item: Stored = { ...copy(base), id, title: "", updatedAt: now(), updatedBy: "あなた（デモ）", values };
    put(collectionId, item);
    return { status: "created", item: copy(item) };
  }),
  uploadImage: async ({ file }, signal) => {
    if (demo.forbidden) return { status: "forbidden" };
    const response = await fetch("/upload", { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" }, signal });
    if (response.status === 413) return { status: "rejected", reason: "size" };
    if (response.status === 415) return { status: "rejected", reason: "type" };
    if (!response.ok) return { status: "rejected", reason: "invalid" };
    return { status: "uploaded", url: (await response.json() as { url: string }).url };
  },
  imageUrl: (url) => url,
  previewUrl: (collectionId, item) => `/preview/${encodeURIComponent(collectionId)}/${encodeURIComponent(item.id)}`,
  isRichTextImageAllowed: (src) => src.startsWith("/media/"),
};

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
    item.version = String(++sequence);
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
    <CollectionWorkspace adapter={adapter} {...(renderRichText ? { renderRichText } : {})} {...(start.collectionId ? { initialCollectionId: start.collectionId } : {})} {...(start.itemId ? { initialItemId: start.itemId } : {})} onNavigate={navigate} />
  </>;
}

createRoot(document.getElementById("root")!).render(<App />);
