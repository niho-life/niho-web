// コレクション画面のテスト用の架空のデータとメモリ上の adapter。実在のサイト・人・URL は使わない。
export const at = "2026-10-20T09:00:00Z";

export const postsDefinition = () => ({
  id: "posts", label: "記事", addLabel: "新しく書く", icon: "document", ordering: "publishedAt", pathPrefix: "/posts/",
  titleField: "title", slugField: "slug", imageField: "cover", subtitleField: null,
  capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: true },
  fields: [
    { key: "title", label: "タイトル", type: "text", required: true, maxLength: 40, placement: "main" },
    { key: "cover", label: "カバー画像", type: "image", placement: "main", hint: "一覧と記事の上に出ます。" },
    { key: "body", label: "本文", type: "richText", placement: "main" },
    { key: "slug", label: "アドレス", type: "slug", required: true, placement: "side" },
    { key: "category", label: "カテゴリ", type: "reference", multiple: false, collectionId: "tags", placement: "side" },
    { key: "related", label: "関連するサークル", type: "reference", multiple: true, collectionId: "circles", placement: "side" },
    { key: "keywords", label: "キーワード", type: "tags", placement: "side" },
    { key: "kind", label: "種類", type: "select", multiple: false, options: [{ id: "news", label: "お知らせ" }, { id: "report", label: "レポート" }], placement: "side" },
    { key: "days", label: "曜日", type: "select", multiple: true, options: [{ id: "mon", label: "月" }, { id: "sat", label: "土" }], placement: "side" },
    { key: "eventAt", label: "開催日時", type: "datetime", placement: "side" },
    { key: "source", label: "参考URL", type: "url", placement: "side" },
    { key: "summary", label: "説明", type: "longText", rows: 3, maxLength: 120, placement: "side", hint: "検索結果に出ます。" },
  ],
});
export const circlesDefinition = () => ({
  id: "circles", label: "サークル", addLabel: "追加する", icon: "people", ordering: "manual", pathPrefix: "/circles/",
  titleField: "title", slugField: "slug", imageField: "photo", subtitleField: "host",
  capabilities: { create: true, duplicate: false, remove: false, unpublish: false, schedule: false },
  fields: [
    { key: "title", label: "名前", type: "text", required: true, placement: "main" },
    { key: "photo", label: "写真", type: "image", shape: "round", placement: "main" },
    { key: "host", label: "主催者名", type: "text", placement: "side" },
    { key: "slug", label: "アドレス", type: "slug", required: true, placement: "side" },
  ],
});
export const tagsDefinition = () => ({
  id: "tags", label: "カテゴリ", addLabel: "追加する", icon: "tag", ordering: "manual", pathPrefix: null,
  titleField: "title", slugField: null, imageField: null, subtitleField: null,
  capabilities: { create: false, duplicate: false, remove: false, unpublish: false, schedule: false },
  fields: [{ key: "title", label: "名前", type: "text", required: true, placement: "main" }],
});
export const schema = () => ({ status: "ready", collections: [postsDefinition(), circlesDefinition(), tagsDefinition()] });
/** 後から足した capabilities（redirects・reorder・bulk・retrySchedule）を全部のコレクションに付けた schema。 */
export const schemaWith = (extra) => { const value = schema(); for (const definition of value.collections) Object.assign(definition.capabilities, extra); return value; };

const emptyPost = { title: "", cover: null, body: "", slug: "", category: [], related: [], keywords: [], kind: [], days: [], eventAt: null, source: "", summary: "" };
const base = { subtitle: null, imageUrl: null, path: null, status: "draft", publishedAt: null, updatedAt: at, updatedBy: "編集担当（架空）", scheduledAt: null, publishFailed: false, order: null, version: "v1" };
export const post = (id, title, overrides = {}, values = {}) => ({ ...base, id, title, ...overrides, values: { ...emptyPost, title, slug: id, ...values } });

export function seed() {
  const posts = [
    post("p1", "海辺の朝さんぽ", { status: "published", publishedAt: "2026-10-20T09:00:00Z", updatedAt: "2026-10-20T09:00:00Z", path: "/posts/morning-walk", imageUrl: "https://media.example.test/p1.jpg" },
      { slug: "morning-walk", cover: "https://media.example.test/p1.jpg", body: "<p>朝の海辺を歩きました。</p>", category: ["t1"], keywords: ["海"], kind: ["report"] }),
    post("p2", "秋の読書会のお知らせ", { updatedAt: "2026-10-22T03:00:00Z", updatedBy: "書き手（架空）" }, { slug: "book-club" }),
    post("p3", "工房の見学レポート", { status: "changed", publishedAt: "2026-10-21T09:00:00Z", updatedAt: "2026-10-24T09:00:00Z", path: "/posts/workshop", publishFailed: true }, { slug: "workshop" }),
    post("p4", "冬至のキャンドルナイト", { status: "scheduled", scheduledAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z" }, { slug: "candle-night" }),
    post("p5", "夏祭りのふりかえり", { status: "publishing", publishedAt: "2026-10-23T09:00:00Z", updatedAt: "2026-10-23T09:00:00Z", path: "/posts/summer" }, { slug: "summer" }),
  ];
  const circle = (id, title, order, status, extra = {}) => ({ ...base, id, title, order, status, publishedAt: status === "draft" ? null : at, path: status === "draft" ? null : `/circles/${id}`, subtitle: `${title}の主催（架空）`, ...extra, values: { title, photo: extra.imageUrl ?? null, host: `${title}の主催（架空）`, slug: id } });
  const circles = [circle("c1", "朝ヨガの会", 2, "published", { imageUrl: "/media/c1.svg" }), circle("c2", "将棋クラブ", 1, "published"), circle("c3", "写真散歩", null, "draft")];
  const tags = [{ ...base, id: "t1", title: "地域", order: 1, status: "published", values: { title: "地域" } }, { ...base, id: "t2", title: "イベント", order: 2, status: "published", values: { title: "イベント" } }];
  return { posts: new Map(posts.map((entry) => [entry.id, entry])), circles: new Map(circles.map((entry) => [entry.id, entry])), tags: new Map(tags.map((entry) => [entry.id, entry])) };
}
export const toSummary = ({ version: _version, values: _values, ...summary }) => summary;
const copy = (value) => structuredClone(value);

/** 呼び出しを記録するメモリ上の adapter。options の同名の関数が値を返したら、その値を応答にする。 */
export function createAdapter(options = {}) {
  const calls = [], store = seed();
  let counter = 100;
  const nextVersion = () => `v${++counter}`;
  const find = ({ collectionId, itemId }) => store[collectionId]?.get(itemId);
  const record = (name, input, signal) => { calls.push({ name, input, signal }); };
  const override = async (name, input, signal) => options[name] ? options[name](input, signal) : undefined;
  const versioned = (input, mutate) => {
    const found = find(input);
    if (!found) return { status: "not_found" };
    if (found.version !== input.version) return { status: "conflict", item: copy(found) };
    mutate(found);
    found.version = nextVersion();
    return { status: "saved", item: copy(found) };
  };
  const adapter = {
    async loadSchema(signal) { record("loadSchema", null, signal); return (await override("loadSchema", null, signal)) ?? schema(); },
    async listItems(input, signal) {
      record("listItems", input, signal);
      return (await override("listItems", input, signal)) ?? { status: "ready", collectionId: input.collectionId, items: [...store[input.collectionId].values()].map((entry) => toSummary(copy(entry))) };
    },
    async loadItem(input, signal) {
      record("loadItem", input, signal);
      const result = await override("loadItem", input, signal);
      if (result !== undefined) return result;
      const found = find(input);
      return found ? { status: "ready", item: copy(found) } : { status: "not_found" };
    },
    async saveDraft(input, signal) {
      record("saveDraft", copy(input), signal);
      return (await override("saveDraft", input, signal)) ?? versioned(input, (found) => {
        Object.assign(found, { values: copy(input.values), title: input.values.title, status: found.status === "published" ? "changed" : found.status, updatedAt: "2026-10-26T01:00:00Z", updatedBy: "あなた" });
      });
    },
    async publish(input, signal) {
      record("publish", input, signal);
      const result = await override("publish", input, signal);
      if (result !== undefined) return result;
      const saved = versioned(input, (found) => Object.assign(found, { status: "publishing", publishedAt: found.publishedAt ?? "2026-10-26T01:00:00Z", path: `/posts/${found.values.slug}` }));
      return saved.status === "saved" ? { status: "publishing", item: saved.item } : saved;
    },
    async discardDraft(input, signal) { record("discardDraft", input, signal); return (await override("discardDraft", input, signal)) ?? versioned(input, (found) => Object.assign(found, { status: "published" })); },
    async unpublish(input, signal) { record("unpublish", input, signal); return (await override("unpublish", input, signal)) ?? versioned(input, (found) => Object.assign(found, { status: "draft", publishedAt: null })); },
    async schedule(input, signal) { record("schedule", input, signal); return (await override("schedule", input, signal)) ?? versioned(input, (found) => Object.assign(found, { status: found.publishedAt ? found.status : "scheduled", scheduledAt: input.at })); },
    async cancelSchedule(input, signal) { record("cancelSchedule", input, signal); return (await override("cancelSchedule", input, signal)) ?? versioned(input, (found) => Object.assign(found, { status: found.status === "scheduled" ? "draft" : found.status, scheduledAt: null })); },
    async duplicate(input, signal) {
      record("duplicate", input, signal);
      const result = await override("duplicate", input, signal);
      if (result !== undefined) return result;
      const found = find(input), id = `copy${++counter}`;
      const item = { ...copy(found), id, title: `${found.title}（複製）`, status: "draft", publishedAt: null, path: null, scheduledAt: null, version: "v1", values: { ...copy(found.values), title: `${found.title}（複製）`, slug: `${found.values.slug}-copy` } };
      store[input.collectionId].set(id, item);
      return { status: "created", item: copy(item) };
    },
    async remove(input, signal) {
      record("remove", input, signal);
      const result = await override("remove", input, signal);
      if (result !== undefined) return result;
      const found = find(input);
      if (!found) return { status: "not_found" };
      if (found.version !== input.version) return { status: "conflict", item: copy(found) };
      store[input.collectionId].delete(input.itemId);
      return { status: "removed" };
    },
    async createItem(input, signal) {
      record("createItem", input, signal);
      const id = `new${++counter}`;
      const values = input.collectionId === "posts" ? { ...emptyPost } : input.collectionId === "circles" ? { title: "", photo: null, host: "", slug: "" } : { title: "" };
      const item = { ...base, id, title: "", values };
      store[input.collectionId].set(id, item);
      return { status: "created", item: copy(item) };
    },
    async retrySchedule(input, signal) {
      record("retrySchedule", input, signal);
      return (await override("retrySchedule", input, signal)) ?? versioned(input, (found) => Object.assign(found, { publishFailed: false }));
    },
    async reorder(input, signal) {
      record("reorder", copy(input), signal);
      const result = await override("reorder", input, signal);
      if (result !== undefined) return result;
      const list = [...store[input.collectionId].values()];
      const current = list.filter((entry) => entry.order !== null).sort((a, b) => a.order - b.order).map((entry) => entry.id);
      if (current.join() !== input.ids.join()) return { status: "conflict", items: list.map((entry) => toSummary(copy(entry))) };
      const next = [...input.ids];
      const [moved] = next.splice(input.from, 1);
      next.splice(input.to, 0, moved);
      next.forEach((id, index) => { const found = store[input.collectionId].get(id); found.order = index + 1; found.version = nextVersion(); });
      return { status: "publishing", items: [...store[input.collectionId].values()].map((entry) => toSummary(copy(entry))) };
    },
    async bulk(input, signal) {
      record("bulk", copy(input), signal);
      const result = await override("bulk", input, signal);
      if (result !== undefined) return result;
      const map = store[input.collectionId];
      if (input.items.some(({ id, version }) => map.get(id)?.version !== version)) return { status: "conflict", items: [...map.values()].map((entry) => toSummary(copy(entry))) };
      for (const { id } of input.items) {
        const found = map.get(id);
        if (input.action === "remove") map.delete(id);
        else if (input.action === "publish") Object.assign(found, { status: "publishing", publishedAt: found.publishedAt ?? "2026-10-26T01:00:00Z", path: found.path ?? `/${input.collectionId}/${id}`, version: nextVersion() });
        else if (found.status === "published" || found.status === "changed") Object.assign(found, { status: "draft", publishedAt: null, path: null, version: nextVersion() });
      }
      return { status: "publishing", items: [...map.values()].map((entry) => toSummary(copy(entry))) };
    },
    async uploadImage(input, signal) {
      record("uploadImage", input, signal);
      return (await override("uploadImage", input, signal)) ?? { status: "uploaded", url: `https://media.example.test/upload-${++counter}.jpg`, width: 1200, height: 800 };
    },
    imageUrl: (url, width) => `${url}${url.includes("?") ? "&" : "?"}w=${width}`,
    previewUrl: (collectionId, item) => `https://preview.example.test/${collectionId}/${item.id}`,
  };
  return { adapter, calls, store, named: (name) => calls.filter((call) => call.name === name) };
}
