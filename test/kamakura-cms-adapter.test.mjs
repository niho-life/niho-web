import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import {
  parseCollectionBulkResult, parseCollectionCreateResult, parseCollectionItemResult, parseCollectionPublishResult, parseCollectionRemoveResult,
  parseCollectionReorderResult, parseCollectionSaveResult, parseCollectionSchemaResult, parseCollectionUploadResult, parseCollectionValues
} from "@niho/web/collection-model";

// 架空の値だけを使う（実在の記事・人・内部 ID は書かない）。
const BASE = "/api/projects/project-kamakura/sites/kamakura/cms";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UPLOAD_URL = `https://next-kamakura.niho.life/internal/studio/cms-upload/${UUID}`;
const SITE = "https://site.example.test";
const signal = () => new AbortController().signal;
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const schema = () => ({
  status: "ready",
  collections: [{
    id: "posts", label: "記事", addLabel: "新しく書く", icon: "document", ordering: "publishedAt", pathPrefix: "/posts/",
    titleField: "title", slugField: "slug", imageField: "cover", subtitleField: null,
    capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: true },
    fields: [
      { key: "title", label: "タイトル", type: "text", required: true, placement: "main" },
      { key: "cover", label: "カバー画像", type: "image", placement: "main" },
      { key: "body", label: "本文", type: "richText", placement: "main" },
      { key: "slug", label: "アドレス", type: "slug", required: true, placement: "side" },
      { key: "tags", label: "タグ", type: "tags", placement: "side" },
      { key: "eventAt", label: "開催日時", type: "datetime", placement: "side" }
    ]
  }]
});
// 上流の values は key が欠けていたり、text に null が入っていたりする（画面は "" にそろえる）。
const rawValues = { title: "海辺の朝さんぽ", body: "<p>朝の海辺。</p>", slug: null, tags: ["海"], works: "画面に出さない値" };
const item = (overrides = {}, values = rawValues) => ({
  id: "morning-walk", title: "海辺の朝さんぽ", subtitle: null, imageUrl: null, path: null, status: "draft",
  publishedAt: null, updatedAt: "2026-10-20T09:00:00Z", updatedBy: "書き手（架空）", scheduledAt: null, publishFailed: false, order: null,
  version: "v1", values, ...overrides
});

async function loadAdapter() {
  const result = await build({ entryPoints: [new URL("../studio/kamakura-cms.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", target: "node22", write: false });
  return import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
}

/** 偽の BFF。routes の `${method} ${path}` に合う関数の戻り値を応答にする。 */
function fakeBff(t, routes) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).startsWith(BASE) ? String(url).slice(BASE.length) : String(url);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body, init });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected request: ${method} ${path}`);
    return handler(body, calls.length);
  });
  return calls;
}

test("CMS adapter: 最後に読んだ値との差分だけを保存し、version が合わなければ上書きせずに競合を返す", async (t) => {
  const { createKamakuraCmsAdapter } = await loadAdapter();
  const definition = parseCollectionSchemaResult(schema()).collections[0];
  let saveReply = () => jsonResponse({ status: "saved", item: item({ version: "v2", title: "新しい題" }, { ...rawValues, title: "新しい題" }) });
  const calls = fakeBff(t, {
    "GET /schema": () => jsonResponse(schema()),
    "GET /collections/posts/items/morning-walk": () => jsonResponse({ status: "ready", item: item() }),
    "PUT /collections/posts/items/morning-walk/draft": (body) => saveReply(body)
  });
  const adapter = createKamakuraCmsAdapter({ siteOrigin: SITE });

  assert.deepEqual(parseCollectionSchemaResult(await adapter.loadSchema(signal())), parseCollectionSchemaResult(schema()));
  const loaded = parseCollectionItemResult(await adapter.loadItem({ collectionId: "posts", itemId: "morning-walk" }, signal()), definition, "morning-walk");
  assert.equal(loaded.status, "ready");
  assert.equal(calls[1].init.credentials, "same-origin");
  assert.equal(calls[1].init.cache, "no-store");

  // 画面は definition の形にそろえた全部の値を渡す。直していない本文・null の slug・欠けた日時は送らない
  const values = { ...parseCollectionValues(rawValues, definition), title: "新しい題" };
  const saved = parseCollectionSaveResult(await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v1", values }, signal()), definition, "morning-walk");
  assert.equal(saved.status, "saved");
  assert.equal(saved.item.version, "v2");
  assert.deepEqual(calls.at(-1).body, { version: "v1", values: { title: "新しい題" } });
  assert.equal(calls.at(-1).method, "PUT");

  // 次の保存は保存結果（v2）との差分。画像を外したら null を送る
  const next = { ...values, tags: ["海", "朝"], cover: null };
  saveReply = () => jsonResponse({ status: "saved", item: item({ version: "v3" }, { ...rawValues, title: "新しい題", tags: ["海", "朝"] }) });
  await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v2", values: next }, signal());
  assert.deepEqual(calls.at(-1).body, { version: "v2", values: { tags: ["海", "朝"] } });

  // 変更が無ければ BFF を呼ばない
  const before = calls.length;
  const unchanged = parseCollectionSaveResult(await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v3", values: next }, signal()), definition, "morning-walk");
  assert.equal(unchanged.status, "saved");
  assert.equal(unchanged.item.version, "v3");
  assert.equal(calls.length, before);

  // 覚えていない version なら読み直し、最新が違えば保存せずに競合
  const conflict = parseCollectionSaveResult(await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v9", values: next }, signal()), definition, "morning-walk");
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.item.version, "v1");
  assert.deepEqual(calls.slice(before).map(({ method, path }) => `${method} ${path}`), ["GET /collections/posts/items/morning-walk"]);

  // 上流の 409・422・403・404・503 を画面の形にする
  saveReply = () => jsonResponse({ error: "conflict", item: item({ version: "v5", updatedBy: "別の書き手（架空）" }) }, 409);
  const remote = parseCollectionSaveResult(await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v1", values: { ...values, title: "もう一度" } }, signal()), definition, "morning-walk");
  assert.deepEqual([remote.status, remote.item.version], ["conflict", "v5"]);
  saveReply = () => jsonResponse({ error: "invalid", errors: [{ field: "slug", message: "このアドレスはほかの記事で使っています。" }] }, 422);
  await adapter.loadItem({ collectionId: "posts", itemId: "morning-walk" }, signal());
  assert.deepEqual(await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v1", values: { ...values, slug: "taken" } }, signal()), { status: "invalid", errors: [{ field: "slug", message: "このアドレスはほかの記事で使っています。" }] });
  saveReply = () => jsonResponse({ error: "forbidden" }, 403);
  assert.deepEqual(await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v1", values: { ...values, slug: "x" } }, signal()), { status: "forbidden" });
  saveReply = () => jsonResponse({ error: "not_found" }, 404);
  assert.deepEqual(await adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v1", values: { ...values, slug: "y" } }, signal()), { status: "not_found" });
  await adapter.loadItem({ collectionId: "posts", itemId: "morning-walk" }, signal());
  saveReply = () => jsonResponse({ error: "service_unavailable", supportId: UUID }, 503);
  await assert.rejects(adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v1", values: { ...values, slug: "z" } }, signal()), (error) => error.name === "KamakuraCmsRequestError" && error.status === 503 && error.supportId === UUID);
  saveReply = () => jsonResponse({ status: "saved", item: item({ id: "other-post" }) });
  await assert.rejects(adapter.saveDraft({ collectionId: "posts", itemId: "morning-walk", version: "v1", values: { ...values, slug: "w" } }, signal()), /contract/u);
  await assert.rejects(adapter.loadItem({ collectionId: "posts", itemId: "../schema" }, signal()), /正しくありません/u);
});

test("CMS adapter: 公開・非公開・複製・削除・予約を契約の形で呼び、画面の parser が読める形で返す", async (t) => {
  const { createKamakuraCmsAdapter } = await loadAdapter();
  const definition = parseCollectionSchemaResult(schema()).collections[0];
  let duplicateReply;
  const calls = fakeBff(t, {
    "GET /schema": () => jsonResponse(schema()),
    "GET /collections/posts/items": () => jsonResponse({ status: "ready", collectionId: "posts", items: [] }),
    "POST /collections/posts/items": () => jsonResponse({ status: "created", item: item({ id: "new-post", title: "" }, {}) }, 201),
    "GET /collections/posts/items/morning-walk": () => jsonResponse({ status: "ready", item: item() }),
    "POST /collections/posts/items/morning-walk/publish": () => jsonResponse({ status: "publishing", item: item({ status: "publishing", version: "v2" }) }, 202),
    "POST /collections/posts/items/morning-walk/unpublish": () => jsonResponse({ status: "publishing", item: item({ status: "publishing", version: "v3" }) }, 202),
    "POST /collections/posts/items/morning-walk/discard-draft": () => jsonResponse({ status: "saved", item: item({ version: "v4" }) }),
    "POST /collections/posts/items/morning-walk/schedule": () => jsonResponse({ status: "saved", item: item({ status: "scheduled", scheduledAt: "2026-11-01T09:00:00Z", version: "v5" }) }),
    "POST /collections/posts/items/morning-walk/cancel-schedule": () => jsonResponse({ error: "conflict", item: item({ version: "v6" }) }, 409),
    "POST /collections/posts/items/morning-walk/duplicate": (body, count) => duplicateReply(body, count),
    "POST /collections/posts/items/morning-walk/remove": () => jsonResponse({ status: "removed" })
  });
  const adapter = createKamakuraCmsAdapter({ siteOrigin: SITE });
  const target = { collectionId: "posts", itemId: "morning-walk" };

  assert.equal((await adapter.listItems({ collectionId: "posts" }, signal())).status, "ready");
  const created = parseCollectionCreateResult(await adapter.createItem({ collectionId: "posts" }, signal()), definition);
  assert.deepEqual([created.status, created.item.id], ["created", "new-post"]);
  assert.deepEqual(calls.at(-1).body, {});

  const published = parseCollectionPublishResult(await adapter.publish({ ...target, version: "v1" }, signal()), definition, "morning-walk");
  assert.deepEqual([published.status, published.item.version], ["publishing", "v2"]);
  assert.deepEqual(calls.at(-1).body, { version: "v1" });
  // 非公開は上流の 202 publishing を、画面の保存の結果（saved）にする
  const unpublished = parseCollectionSaveResult(await adapter.unpublish({ ...target, version: "v2" }, signal()), definition, "morning-walk");
  assert.deepEqual([unpublished.status, unpublished.item.status], ["saved", "publishing"]);
  assert.equal(parseCollectionSaveResult(await adapter.discardDraft({ ...target, version: "v3" }, signal()), definition, "morning-walk").status, "saved");
  const scheduled = parseCollectionSaveResult(await adapter.schedule({ ...target, version: "v4", at: "2026-11-01T09:00:00.000Z" }, signal()), definition, "morning-walk");
  assert.equal(scheduled.item.status, "scheduled");
  assert.deepEqual(calls.at(-1).body, { version: "v4", at: "2026-11-01T09:00:00.000Z" });
  assert.equal(parseCollectionSaveResult(await adapter.cancelSchedule({ ...target, version: "v5" }, signal()), definition, "morning-walk").status, "conflict");

  // 複製は覚えている version を送る。競合なら最新でもう一度だけ試す
  duplicateReply = (body) => body.version === "v6"
    ? jsonResponse({ error: "conflict", item: item({ version: "v7" }) }, 409)
    : jsonResponse({ status: "created", item: item({ id: "morning-walk-2", version: "c1" }) }, 201);
  const duplicated = parseCollectionCreateResult(await adapter.duplicate(target, signal()), definition);
  assert.deepEqual([duplicated.status, duplicated.item.id], ["created", "morning-walk-2"]);
  assert.deepEqual(calls.filter(({ path }) => path.endsWith("/duplicate")).map(({ body }) => body.version), ["v6", "v7"]);
  duplicateReply = () => jsonResponse({ status: "created", item: item() }, 201);
  await assert.rejects(adapter.duplicate(target, signal()), /複製の結果/u);

  assert.deepEqual(parseCollectionRemoveResult(await adapter.remove({ ...target, version: "v7" }, signal()), definition, "morning-walk"), { status: "removed" });
  // 削除した項目は覚えていないので、複製の前に読み直す
  duplicateReply = () => jsonResponse({ error: "not_found" }, 404);
  const beforeDuplicate = calls.length;
  assert.deepEqual(await adapter.duplicate(target, signal()), { status: "not_found" });
  assert.deepEqual(calls.slice(beforeDuplicate).map(({ method, path }) => `${method} ${path}`), ["GET /collections/posts/items/morning-walk", "POST /collections/posts/items/morning-walk/duplicate"]);
});

test("CMS adapter: 画像は intent の URL を確かめてから credentials なしで直接 PUT し、拒否は理由つきで返す", async (t) => {
  const { createKamakuraCmsAdapter } = await loadAdapter();
  const file = new File([new Uint8Array(32)], "朝の\n海.png", { type: "image/png" });
  let intentReply = () => jsonResponse({ uploadUrl: UPLOAD_URL, uploadToken: "token.value", uploadId: UUID }, 201);
  let putReply = () => jsonResponse({ url: "https://kamakura-media.niho.life/uploads/2026/10/aaaaaaaaaaaaaaaa.png", width: 1200, height: 800 }, 201);
  const calls = fakeBff(t, {
    "POST /uploads/intent": (body) => intentReply(body),
    [`PUT ${UPLOAD_URL}`]: () => putReply()
  });
  const adapter = createKamakuraCmsAdapter({ siteOrigin: SITE });

  const uploaded = parseCollectionUploadResult(await adapter.uploadImage({ collectionId: "posts", file }, signal()));
  assert.deepEqual(uploaded, { status: "uploaded", url: "https://kamakura-media.niho.life/uploads/2026/10/aaaaaaaaaaaaaaaa.png", width: 1200, height: 800 });
  assert.deepEqual(calls[0].body, { collectionId: "posts", name: "朝の海.png", mimeType: "image/png", bytes: 32 });
  assert.equal(calls[1].method, "PUT");
  assert.equal(calls[1].init.credentials, "omit", "Access の Cookie を鎌倉の Worker へ送らない");
  assert.equal(calls[1].init.mode, "cors");
  assert.equal(calls[1].init.redirect, "error");
  assert.equal(calls[1].init.headers.Authorization, "Bearer token.value");
  assert.equal(calls[1].init.headers["Content-Type"], "image/png");
  assert.equal(calls[1].body, file);

  // 行き先が違う intent では PUT しない
  for (const bad of [
    { uploadUrl: `https://evil.example/internal/studio/cms-upload/${UUID}`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: `http://next-kamakura.niho.life/internal/studio/cms-upload/${UUID}`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: `${UPLOAD_URL}#x`, uploadToken: "t", uploadId: UUID },
    { uploadUrl: UPLOAD_URL, uploadToken: "t", uploadId: "123e4567-e89b-42d3-a456-426614174001" },
    { uploadUrl: UPLOAD_URL, uploadToken: "t", uploadId: UUID, extra: true }
  ]) {
    intentReply = () => jsonResponse(bad, 201);
    const before = calls.length;
    await assert.rejects(adapter.uploadImage({ collectionId: "posts", file }, signal()));
    assert.equal(calls.length, before + 1, "intent だけ呼び、PUT しない");
  }
  intentReply = () => jsonResponse({ uploadUrl: UPLOAD_URL, uploadToken: "token.value", uploadId: UUID }, 201);
  for (const url of ["https://cdn.example.test/uploads/a.png", "https://kamakura-media.niho.life/other/a.png", "https://kamakura-media.niho.life/uploads/a.png?x=1"]) {
    putReply = () => jsonResponse({ url, width: 1, height: 1 }, 201);
    await assert.rejects(adapter.uploadImage({ collectionId: "posts", file }, signal()));
  }

  // 拒否
  const before = calls.length;
  assert.deepEqual(await adapter.uploadImage({ collectionId: "posts", file: new File(["<svg/>"], "a.svg", { type: "image/svg+xml" }) }, signal()), { status: "rejected", reason: "type" });
  assert.deepEqual(await adapter.uploadImage({ collectionId: "posts", file: new File([], "a.png", { type: "image/png" }) }, signal()), { status: "rejected", reason: "invalid" });
  assert.equal(calls.length, before, "形式・大きさが合わなければ BFF を呼ばない");
  for (const [status, reason] of [[403, "permission"], [413, "size"], [415, "type"], [400, "invalid"]]) {
    intentReply = () => jsonResponse({ error: "x" }, status);
    assert.deepEqual(await adapter.uploadImage({ collectionId: "posts", file }, signal()), { status: "rejected", reason });
  }
  intentReply = () => jsonResponse({ uploadUrl: UPLOAD_URL, uploadToken: "token.value", uploadId: UUID }, 201);
  for (const [status, reason] of [[413, "size"], [415, "type"]]) {
    putReply = () => jsonResponse({ error: "x" }, status);
    assert.deepEqual(await adapter.uploadImage({ collectionId: "posts", file }, signal()), { status: "rejected", reason });
  }
  putReply = () => jsonResponse({ error: "used" }, 409);
  await assert.rejects(adapter.uploadImage({ collectionId: "posts", file }, signal()), (error) => error.name === "KamakuraCmsRequestError" && error.status === 409);
});

test("CMS adapter: 画像の縮小は公開画像の置き場だけ、プレビューは公開中の項目だけサイトの URL で開く", async () => {
  const { createKamakuraCmsAdapter } = await loadAdapter();
  const adapter = createKamakuraCmsAdapter({ siteOrigin: SITE });
  assert.equal(adapter.imageUrl("https://kamakura-media.niho.life/uploads/2026/10/a.jpg", 160), "https://kamakura-media.niho.life/cdn-cgi/image/width=160,format=auto/uploads/2026/10/a.jpg");
  assert.equal(adapter.imageUrl("https://kamakura-media.niho.life/uploads/a.jpg", 99999), "https://kamakura-media.niho.life/cdn-cgi/image/width=4096,format=auto/uploads/a.jpg");
  for (const url of ["https://cdn.example.test/a.jpg", "https://kamakura-media.niho.life/cdn-cgi/image/width=80/uploads/a.jpg", "https://kamakura-media.niho.life/uploads/a.jpg?v=1", "/media/a.jpg", "not a url"]) {
    assert.equal(adapter.imageUrl(url, 160), url);
  }
  assert.equal(adapter.imageUrl("https://kamakura-media.niho.life/uploads/a.jpg", Number.NaN), "https://kamakura-media.niho.life/uploads/a.jpg");

  const published = item({ status: "published", path: "/posts/morning-walk", publishedAt: "2026-10-20T09:00:00Z" });
  assert.equal(adapter.previewUrl("posts", published), `${SITE}/posts/morning-walk`);
  assert.equal(adapter.previewUrl("posts", { ...published, status: "changed" }), `${SITE}/posts/morning-walk`);
  for (const status of ["draft", "publishing", "scheduled"]) assert.equal(adapter.previewUrl("posts", { ...published, status }), null, status);
  assert.equal(adapter.previewUrl("posts", { ...published, path: null }), null);
  assert.equal(adapter.previewUrl("posts", { ...published, path: "//evil.example/x" }), null);
  for (const siteOrigin of [null, "", "http://site.example.test", "https://site.example.test/base", "https://user:pass@site.example.test"]) {
    assert.equal(createKamakuraCmsAdapter({ siteOrigin }).previewUrl("posts", published), null, String(siteOrigin));
  }
  assert.equal(adapter.isRichTextImageAllowed, undefined, "本文の画像は既定どおり https だけ");
});

// U2-e: 後から足した capabilities・gallery・並べ替え・まとめての操作・転送・予約のやり直し
const nextSchema = () => ({
  status: "ready",
  collections: [
    { ...schema().collections[0], capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: true, redirects: true, reorder: false, bulk: true, retrySchedule: true } },
    {
      id: "companies", label: "会社", addLabel: "追加する", icon: "person", ordering: "manual", pathPrefix: "/companies/",
      titleField: "name", slugField: null, imageField: null, subtitleField: null,
      capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: false, redirects: true, reorder: true, bulk: true, retrySchedule: false },
      fields: [
        { key: "name", label: "名前", type: "text", required: true, placement: "main" },
        { key: "portfolio", label: "作品／活動", type: "gallery", captionLabel: "説明", placement: "main", maxItems: 60, captionMaxLength: 2000 }
      ]
    }
  ]
});
const summaryOf = ({ version: _version, values: _values, ...rest }) => rest;
const company = (overrides = {}, portfolio = [{ id: "w1", image: "https://kamakura-media.niho.life/uploads/w1.jpg", caption: "一つ目" }]) => item({ id: "shop-a", title: "架空の店", path: "/companies/shop-a", status: "published", publishedAt: "2026-10-20T09:00:00Z", order: 1, ...overrides }, { name: "架空の店", portfolio });

test("CMS adapter: 新しい schema（9 つの capabilities・gallery）を読み、gallery は行ごとに比べて直したときだけ送る", async (t) => {
  const { createKamakuraCmsAdapter } = await loadAdapter();
  const definition = parseCollectionSchemaResult(nextSchema()).collections[1];
  let saveReply = (body) => jsonResponse({ status: "saved", item: company({ version: "v2" }, body.values.portfolio) });
  const calls = fakeBff(t, {
    "GET /schema": () => jsonResponse(nextSchema()),
    "GET /collections/companies/items/shop-a": () => jsonResponse({ status: "ready", item: company() }),
    "PUT /collections/companies/items/shop-a/draft": (body) => saveReply(body)
  });
  const adapter = createKamakuraCmsAdapter({ siteOrigin: SITE });
  assert.deepEqual(parseCollectionSchemaResult(await adapter.loadSchema(signal())).collections[1].capabilities.reorder, true);
  const loaded = parseCollectionItemResult(await adapter.loadItem({ collectionId: "companies", itemId: "shop-a" }, signal()), definition, "shop-a");
  const same = loaded.item.values;
  const before = calls.length;
  // 中身が同じ新しい配列（画面の正規化）なら送らない
  await adapter.saveDraft({ collectionId: "companies", itemId: "shop-a", version: "v1", values: { ...same, portfolio: same.portfolio.map((entry) => ({ ...entry })) } }, signal());
  assert.equal(calls.length, before);
  const next = [...same.portfolio, { id: "", image: null, caption: "新しい行" }];
  const saved = parseCollectionSaveResult(await adapter.saveDraft({ collectionId: "companies", itemId: "shop-a", version: "v1", values: { ...same, portfolio: next } }, signal()), definition, "shop-a");
  assert.equal(saved.status, "saved");
  assert.deepEqual(calls.at(-1).body, { version: "v1", values: { portfolio: next } });
  saveReply = () => jsonResponse({ status: "saved", item: company({ version: "v3" }, [{ id: "w1", image: null, caption: "x", extra: 1 }]) });
  await assert.rejects(adapter.saveDraft({ collectionId: "companies", itemId: "shop-a", version: "v2", values: { ...same, portfolio: [] } }, signal()), /contract/u);
});

test("CMS adapter: 転送・削除の移動先・予約のやり直し・並べ替え・まとめての操作を契約の形で呼ぶ", async (t) => {
  const { createKamakuraCmsAdapter } = await loadAdapter();
  const definition = parseCollectionSchemaResult(nextSchema()).collections[0];
  let removeReply = () => jsonResponse({ status: "removed" });
  let retryReply = () => jsonResponse({ status: "saved", item: item({ status: "scheduled", scheduledAt: "2026-11-01T09:00:00Z", version: "v3" }) });
  let reorderReply = () => jsonResponse({ status: "publishing", items: [summaryOf(company({ order: 2 })), summaryOf(company({ id: "shop-b", order: 1 }))] }, 202);
  let bulkReply = () => jsonResponse({ status: "publishing", items: [summaryOf(item({ status: "publishing" }))] }, 202);
  const calls = fakeBff(t, {
    "GET /schema": () => jsonResponse(nextSchema()),
    "POST /collections/posts/items/morning-walk/publish": () => jsonResponse({ status: "publishing", item: item({ status: "publishing", version: "v2" }) }, 202),
    "POST /collections/posts/items/morning-walk/schedule": () => jsonResponse({ status: "saved", item: item({ status: "scheduled", scheduledAt: "2026-11-01T09:00:00Z", version: "v2" }) }),
    "POST /collections/posts/items/morning-walk/remove": () => removeReply(),
    "POST /collections/posts/items/morning-walk/retry-schedule": () => retryReply(),
    "POST /collections/companies/reorder": () => reorderReply(),
    "POST /collections/posts/bulk": () => bulkReply()
  });
  const adapter = createKamakuraCmsAdapter({ siteOrigin: SITE });
  const target = { collectionId: "posts", itemId: "morning-walk" };

  // redirect は画面が付けたときだけ送る
  await adapter.publish({ ...target, version: "v1" }, signal());
  assert.deepEqual(calls.at(-1).body, { version: "v1" });
  assert.equal(parseCollectionPublishResult(await adapter.publish({ ...target, version: "v1", redirect: false }, signal()), definition, "morning-walk").status, "publishing");
  assert.deepEqual(calls.at(-1).body, { version: "v1", redirect: false });
  await adapter.schedule({ ...target, version: "v1", at: "2026-11-01T09:00:00.000Z", redirect: true }, signal());
  assert.deepEqual(calls.at(-1).body, { version: "v1", at: "2026-11-01T09:00:00.000Z", redirect: true });

  // 削除の移動先: 無し・null・ほかの項目の path。422 は選び直し
  for (const [extra, body] of [[{}, { version: "v1" }], [{ redirectTo: null }, { version: "v1", redirectTo: null }], [{ redirectTo: "/posts/other" }, { version: "v1", redirectTo: "/posts/other" }]]) {
    assert.deepEqual(await adapter.remove({ ...target, version: "v1", ...extra }, signal()), { status: "removed" });
    assert.deepEqual(calls.at(-1).body, body);
  }
  removeReply = () => jsonResponse({ error: "invalid", errors: [{ field: "", message: "移動先を選び直してください" }] }, 422);
  assert.deepEqual(parseCollectionRemoveResult(await adapter.remove({ ...target, version: "v1", redirectTo: "/posts/gone" }, signal()), definition, "morning-walk"), { status: "invalid", errors: [{ field: "", message: "移動先を選び直してください" }] });

  // 予約のやり直し
  const retried = parseCollectionSaveResult(await adapter.retrySchedule({ ...target, version: "v2" }, signal()), definition, "morning-walk");
  assert.deepEqual([retried.status, retried.item.version], ["saved", "v3"]);
  assert.deepEqual(calls.at(-1).body, { version: "v2" });
  retryReply = () => jsonResponse({ error: "invalid", errors: [{ field: "", message: "失敗した予約はありません。" }] }, 422);
  assert.equal(parseCollectionSaveResult(await adapter.retrySchedule({ ...target, version: "v2" }, signal()), definition, "morning-walk").status, "invalid");

  // 並べ替え: 202 は一覧つき、409 は今の一覧つきの conflict、404・403 は画面の形
  const reordered = parseCollectionReorderResult(await adapter.reorder({ collectionId: "companies", ids: ["shop-a", "shop-b"], from: 0, to: 1 }, signal()));
  assert.deepEqual([reordered.status, reordered.items.map((entry) => entry.id)], ["publishing", ["shop-a", "shop-b"]]);
  assert.deepEqual(calls.at(-1).body, { ids: ["shop-a", "shop-b"], from: 0, to: 1 });
  reorderReply = () => jsonResponse({ error: "conflict", items: [summaryOf(company())] }, 409);
  assert.equal(parseCollectionReorderResult(await adapter.reorder({ collectionId: "companies", ids: ["shop-a", "shop-b"], from: 1, to: 0 }, signal())).status, "conflict");
  reorderReply = () => jsonResponse({ error: "not_found" }, 404);
  assert.deepEqual(await adapter.reorder({ collectionId: "companies", ids: ["shop-a", "shop-b"], from: 1, to: 0 }, signal()), { status: "not_found" });
  reorderReply = () => jsonResponse({ error: "forbidden" }, 403);
  assert.deepEqual(await adapter.reorder({ collectionId: "companies", ids: ["shop-a", "shop-b"], from: 1, to: 0 }, signal()), { status: "forbidden" });
  reorderReply = () => jsonResponse({ status: "publishing", items: [], extra: true }, 202);
  await assert.rejects(adapter.reorder({ collectionId: "companies", ids: ["shop-a", "shop-b"], from: 1, to: 0 }, signal()), /contract/u);
  await assert.rejects(adapter.reorder({ collectionId: "../x", ids: ["a", "b"], from: 1, to: 0 }, signal()), /正しくありません/u);

  // まとめての操作: 202 publishing・200 saved・409・422
  const items = [{ id: "morning-walk", version: "v1" }];
  assert.equal(parseCollectionBulkResult(await adapter.bulk({ collectionId: "posts", action: "publish", items }, signal())).status, "publishing");
  assert.deepEqual(calls.at(-1).body, { action: "publish", items });
  bulkReply = () => jsonResponse({ status: "saved", items: [] });
  assert.deepEqual(parseCollectionBulkResult(await adapter.bulk({ collectionId: "posts", action: "remove", items }, signal())), { status: "saved", items: [] });
  bulkReply = () => jsonResponse({ error: "conflict", items: [summaryOf(item())] }, 409);
  assert.equal(parseCollectionBulkResult(await adapter.bulk({ collectionId: "posts", action: "unpublish", items }, signal())).status, "conflict");
  bulkReply = () => jsonResponse({ error: "invalid", errors: [{ field: "", message: "「海辺の朝さんぽ」は公開できません。" }] }, 422);
  assert.deepEqual(parseCollectionBulkResult(await adapter.bulk({ collectionId: "posts", action: "publish", items }, signal())), { status: "invalid", errors: [{ field: "", message: "「海辺の朝さんぽ」は公開できません。" }] });
  bulkReply = () => jsonResponse({ status: "saved", items: [] }, 202);
  await assert.rejects(adapter.bulk({ collectionId: "posts", action: "publish", items }, signal()), /contract/u);
});
