import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createAdapter, schema } from "./collection-fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://host.example.test/studio" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "DOMParser", "File"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CollectionWorkspace } = await import("@niho/web/collection-workspace");

const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const flush = async () => { for (let i = 0; i < 4; i++) await wait(0); };
const nameOf = (node) => (node.getAttribute("aria-label") || node.textContent).replace(/\s+/gu, " ").trim();
const buttons = (scope = document) => [...scope.querySelectorAll("button")];
const button = (name, scope = document) => buttons(scope).find((node) => nameOf(node) === name);
const click = async (target) => { assert.ok(target, "button not found"); await act(async () => target.click()); await flush(); };
const press = async (name, scope) => { const target = button(name, scope); assert.ok(target, `button ${name}`); await click(target); };
const valueSetter = (node) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value").set;
async function type(node, value) {
  assert.ok(node, "input not found");
  await act(async () => { valueSetter(node).call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
}
async function key(node, keyName, options = {}) { await act(async () => node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...options }))); await flush(); }
async function chooseFile(input, file) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  await flush();
}
const field = (key) => document.querySelector(`[data-field="${key}"]`);
const rows = () => [...document.querySelectorAll(".cw-row")];
const rowTitles = () => rows().map((row) => row.querySelector(".cw-row-title").textContent);
const lastSave = (fixture) => fixture.named("saveDraft").at(-1)?.input;

async function setup(props) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), navigations = [];
  let current = { onNavigate: (state) => navigations.push(state), ...props };
  const render = async (next = {}) => { current = { ...current, ...next }; await act(async () => root.render(createElement(CollectionWorkspace, current))); await flush(); };
  await render();
  return { navigations, render, container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function openRow(title) {
  const target = [...document.querySelectorAll("button.cw-row-open")].find((node) => node.querySelector(".cw-row-title").textContent === title);
  await click(target);
}

test("list: nav, counts, rows, search and tabs follow the definitions and both orderings", async () => {
  const fixture = createAdapter();
  const app = await setup({ adapter: fixture.adapter });
  try {
    const nav = [...document.querySelectorAll(".cw-nav button")];
    assert.deepEqual(nav.map(nameOf), ["記事（5 件）", "サークル（3 件）", "カテゴリ（2 件）"]);
    assert.equal(nav[0].getAttribute("aria-current"), "page");
    assert.equal(document.querySelector(".cw-list-title h2").textContent, "記事");
    assert.equal(document.querySelector(".cw-count").textContent, "5 件");
    assert.deepEqual([...document.querySelectorAll(".cw-filters button")].map(nameOf), ["すべて（5 件）", "公開中（3 件）", "下書き（2 件）"]);
    assert.deepEqual(rowTitles(), ["秋の読書会のお知らせ", "冬至のキャンドルナイト", "夏祭りのふりかえり", "工房の見学レポート", "海辺の朝さんぽ"]);
    const byTitle = (title) => rows().find((row) => row.querySelector(".cw-row-title").textContent === title);
    assert.ok(byTitle("海辺の朝さんぽ").textContent.includes("公開中"));
    assert.ok(byTitle("海辺の朝さんぽ").querySelector(".cw-row-sub").textContent.includes("/posts/morning-walk"));
    assert.equal(byTitle("海辺の朝さんぽ").querySelector(".cw-cell-published time").textContent, "2026/10/20 18:00");
    assert.ok(byTitle("海辺の朝さんぽ").querySelector(".cw-cell-updated").textContent.includes("編集担当（架空）"));
    assert.equal(byTitle("海辺の朝さんぽ").querySelector(".cw-thumb img").getAttribute("src"), "https://media.example.test/p1.jpg?w=160");
    assert.ok(byTitle("工房の見学レポート").textContent.includes("変更あり"));
    assert.ok(byTitle("工房の見学レポート").textContent.includes("前回の公開に失敗"));
    assert.ok(byTitle("秋の読書会のお知らせ").textContent.includes("下書き"));
    assert.ok(byTitle("夏祭りのふりかえり").textContent.includes("反映中"));
    assert.ok(byTitle("冬至のキャンドルナイト").textContent.includes("予約 10/30 9:00"));
    for (const row of rows()) assert.ok(row.querySelector(".cw-pill").textContent.trim(), "status is written in words, not only color");

    await type(document.querySelector(".cw-search input"), "工房");
    assert.deepEqual(rowTitles(), ["工房の見学レポート"]);
    await type(document.querySelector(".cw-search input"), "存在しない");
    assert.ok(document.body.textContent.includes("「存在しない」に当てはまる記事はありません。"));
    await press("絞り込みをやめる");
    await press("下書き（2 件）");
    assert.equal(button("下書き（2 件）").getAttribute("aria-pressed"), "true");
    assert.deepEqual(rowTitles(), ["秋の読書会のお知らせ", "冬至のキャンドルナイト"]);
    await press("公開中（3 件）");
    assert.deepEqual(rowTitles(), ["夏祭りのふりかえり", "工房の見学レポート", "海辺の朝さんぽ"]);
    assert.ok(button("新しく書く"));

    await press("サークル（3 件）");
    assert.deepEqual(app.navigations.at(-1), { collectionId: "circles", itemId: null });
    assert.deepEqual(rowTitles(), ["写真散歩", "将棋クラブ", "朝ヨガの会"], "manual ordering: no order first, then ascending");
    assert.ok(rows().every((row) => row.querySelector(".cw-thumb").dataset.shape === "round"));
    assert.equal(rows()[2].querySelector(".cw-thumb img").getAttribute("src"), "/media/c1.svg?w=160");
    assert.ok(rows()[2].querySelector(".cw-row-sub").textContent.includes("朝ヨガの会の主催（架空）"), "subtitle is shown under the title");
    await press("「写真散歩」の操作");
    assert.deepEqual([...document.querySelectorAll('[role="menu"] button')].map(nameOf), ["開く"], "capabilities false hide duplicate, unpublish and remove");
    await key(document.activeElement, "Escape");
    assert.equal(document.activeElement, button("「写真散歩」の操作"));
    await press("カテゴリ（2 件）");
    assert.equal(button("追加する"), undefined, "create false hides the add button");
    assert.deepEqual(rowTitles(), ["地域", "イベント"]);
  } finally { await app.cleanup(); }
});

test("editor: opens an item, splits main and side, and autosaves once about a second after editing", async () => {
  const fixture = createAdapter();
  const app = await setup({ adapter: fixture.adapter });
  try {
    await openRow("海辺の朝さんぽ");
    assert.deepEqual(app.navigations.at(-1), { collectionId: "posts", itemId: "p1" });
    assert.deepEqual(fixture.named("loadItem").at(-1).input, { collectionId: "posts", itemId: "p1" });
    const mainKeys = [...document.querySelectorAll(".cw-editor-main [data-field]")].map((node) => node.dataset.field);
    const sideKeys = [...document.querySelectorAll(".cw-editor-side [data-field]")].map((node) => node.dataset.field);
    assert.deepEqual(mainKeys, ["title", "cover", "body"]);
    assert.deepEqual(sideKeys, ["slug", "category", "related", "keywords", "kind", "days", "eventAt", "source", "summary"]);
    assert.ok(document.querySelector(".cw-editor-side .cw-side-section h3").textContent === "公開");
    assert.ok(document.querySelector(".cw-facts").textContent.includes("/posts/morning-walk"));
    assert.equal(field("cover").querySelector(".cw-hint").textContent, "一覧と記事の上に出ます。");
    assert.equal(document.querySelector(".cw-editor-actions a").getAttribute("href"), "https://preview.example.test/posts/p1");
    assert.equal(button("公開中").disabled, true);
    for (const input of document.querySelectorAll(".cw-editor input:not([type=file]), .cw-editor textarea, .cw-editor [contenteditable]")) {
      const labelled = input.getAttribute("aria-label") || input.getAttribute("aria-labelledby") || document.querySelector(`label[for="${input.id}"]`) || input.closest("label");
      assert.ok(labelled, `input ${input.id} has a label`);
    }

    const title = document.getElementById(document.querySelector('[data-field="title"] label').htmlFor);
    await type(title, "海辺の朝");
    await type(title, "海辺の朝さんぽ（改）");
    assert.equal(document.querySelector(".cw-save-state").textContent, "保存中…");
    assert.equal(button("変更を公開する").disabled, false);
    await wait(500);
    assert.equal(fixture.named("saveDraft").length, 0, "waits before saving");
    await wait(700);
    assert.equal(fixture.named("saveDraft").length, 1, "saves once");
    assert.equal(lastSave(fixture).version, "v1");
    assert.equal(lastSave(fixture).values.title, "海辺の朝さんぽ（改）");
    assert.deepEqual(Object.keys(lastSave(fixture).values), ["title", "cover", "body", "slug", "category", "related", "keywords", "kind", "days", "eventAt", "source", "summary"]);
    await flush();
    assert.equal(document.querySelector(".cw-save-state").textContent, "保存しました");
    assert.ok(document.querySelector(".cw-editor-status").textContent.includes("変更あり"));
    await type(title, "海辺の朝さんぽ（再）");
    await wait(1100);
    assert.equal(fixture.named("saveDraft").length, 2);
    assert.equal(lastSave(fixture).version, "v101", "the next save uses the version the first save returned");
  } finally { await app.cleanup(); }
});

test("editor: conflict never overwrites and reloads on request; invalid shows errors under fields", async () => {
  let mode = "conflict";
  const fixture = createAdapter({
    saveDraft: async (input) => {
      if (mode === "conflict") { mode = "ok"; fixture.store.posts.get("p1").title = "ほかの人の題名"; fixture.store.posts.get("p1").values.title = "ほかの人の題名"; fixture.store.posts.get("p1").version = "v9"; return { status: "conflict", item: structuredClone(fixture.store.posts.get("p1")) }; }
      if (mode === "invalid") return { status: "invalid", errors: [{ field: "slug", message: "このアドレスはほかの記事が使っています。" }, { field: "", message: "全体の確かめに失敗しました。" }] };
      return undefined;
    },
  });
  const app = await setup({ adapter: fixture.adapter, autosaveDelay: 20, initialCollectionId: "posts", initialItemId: "p1" });
  try {
    assert.equal(app.navigations.length, 0, "the initial view does not navigate");
    const title = () => document.querySelector('[data-field="title"] input');
    await type(title(), "わたしの題名");
    await wait(60); await flush();
    const alert = document.querySelector('.cw-banner[role="alert"]');
    assert.ok(alert.textContent.includes("ほかの人が先に保存しました"));
    assert.ok(alert.textContent.includes("いま直したところは消えます"));
    await type(title(), "わたしの題名2");
    await wait(60);
    assert.equal(fixture.named("saveDraft").length, 1, "no further save while in conflict");
    assert.equal(button("変更を公開する")?.disabled ?? button("公開する")?.disabled ?? true, true);
    await press("最新を読み込む");
    assert.equal(title().value, "ほかの人の題名");
    assert.equal(document.querySelector('.cw-banner[role="alert"]'), null);

    mode = "invalid";
    await type(document.querySelector('[data-field="slug"] input'), "taken");
    await wait(60); await flush();
    assert.equal(field("slug").querySelector(".cw-error").textContent, "このアドレスはほかの記事が使っています。");
    assert.equal(field("slug").querySelector("input").getAttribute("aria-invalid"), "true");
    assert.ok(field("slug").querySelector("input").getAttribute("aria-describedby").includes(field("slug").querySelector(".cw-error").id));
    assert.ok(document.body.textContent.includes("全体の確かめに失敗しました。"));
    assert.equal(document.querySelector(".cw-save-state").textContent, "保存できませんでした（直すところがあります）");
    assert.equal(fixture.named("saveDraft").at(-1).input.version, "v9");
  } finally { await app.cleanup(); }
});

test("editor: publish stops on required and slug errors with focus, then flushes the draft and publishes", async () => {
  const fixture = createAdapter();
  Object.assign(fixture.store.posts.get("p2"), { title: "" });
  Object.assign(fixture.store.posts.get("p2").values, { title: "", slug: "日本語のアドレス" });
  const app = await setup({ adapter: fixture.adapter, autosaveDelay: 5000, initialCollectionId: "posts", initialItemId: "p2" });
  try {
    await press("公開する");
    assert.equal(fixture.named("publish").length, 0);
    assert.equal(field("title").querySelector(".cw-error").textContent, "入力してください。");
    assert.ok(field("slug").querySelector(".cw-error").textContent.includes("半角の英数字"));
    assert.equal(document.activeElement, field("title").querySelector("input"), "focus moves to the first invalid field");
    assert.ok(document.querySelector('.cw-banner[role="alert"]').textContent.includes("公開できません"));
    await type(field("title").querySelector("input"), "秋の読書会");
    assert.equal(field("title").querySelector(".cw-error"), null, "editing clears the field error");
    await press("公開する");
    assert.equal(document.activeElement, field("slug").querySelector("input"));
    await type(field("slug").querySelector("input"), "book-club");
    await press("公開する");
    await flush();
    const order = fixture.calls.map((call) => call.name).filter((name) => name === "saveDraft" || name === "publish");
    assert.deepEqual(order, ["saveDraft", "publish"], "the waiting draft is saved before publishing");
    assert.equal(fixture.named("publish")[0].input.version, "v101");
    assert.ok(document.querySelector('.cw-banner[role="status"]').textContent.includes("公開しました。サイトに出るまで少しかかります。"));
    assert.equal(button("反映中").disabled, true);
  } finally { await app.cleanup(); }
});

test("editor: image, reference, tags, select, datetime, url and rich text change values in the contract shapes", async () => {
  let reject = false;
  const fixture = createAdapter({ uploadImage: async () => reject ? { status: "rejected", reason: "size" } : undefined });
  const app = await setup({ adapter: fixture.adapter, autosaveDelay: 10, initialCollectionId: "posts", initialItemId: "p1" });
  const settle = async () => { await wait(40); await flush(); };
  try {
    assert.equal(field("cover").querySelector("img").getAttribute("src"), "https://media.example.test/p1.jpg?w=480");
    const photo = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    await chooseFile(field("cover").querySelector('input[type="file"]'), photo);
    assert.equal(fixture.named("uploadImage")[0].input.collectionId, "posts");
    assert.equal(fixture.named("uploadImage")[0].input.file, photo);
    await settle();
    assert.match(lastSave(fixture).values.cover, /^https:\/\/media\.example\.test\/upload-\d+\.jpg$/u);
    await press("カバー画像を外す");
    await settle();
    assert.equal(lastSave(fixture).values.cover, null);
    reject = true;
    await chooseFile(field("cover").querySelector('input[type="file"]'), photo);
    assert.ok(field("cover").querySelector('[role="alert"]').textContent.includes("画像が大きすぎます"));
    reject = false;

    const categorySearch = field("category").querySelector('input[type="search"]');
    await type(categorySearch, "イベ");
    await press("イベント", field("category"));
    await settle();
    assert.deepEqual(lastSave(fixture).values.category, ["t2"]);
    await type(field("category").querySelector('input[type="search"]'), "地");
    await press("地域", field("category"));
    await settle();
    assert.deepEqual(lastSave(fixture).values.category, ["t1"], "single reference replaces");
    await press("「地域」を外す");
    await settle();
    assert.deepEqual(lastSave(fixture).values.category, []);
    await type(field("related").querySelector('input[type="search"]'), "将棋");
    await press("将棋クラブ", field("related"));
    await type(field("related").querySelector('input[type="search"]'), "ヨガ");
    await press("朝ヨガの会", field("related"));
    await settle();
    assert.deepEqual(lastSave(fixture).values.related, ["c2", "c1"]);

    const tag = field("keywords").querySelector('input[type="text"]');
    await type(tag, "朝"); await key(tag, "Enter");
    await type(tag, "朝"); await key(tag, "Enter");
    await type(tag, "  散歩  "); await press("足す", field("keywords"));
    await press("「海」を外す");
    await settle();
    assert.deepEqual(lastSave(fixture).values.keywords, ["朝", "散歩"]);
    await type(tag, "変換中"); await key(tag, "Enter", { isComposing: true });
    assert.equal(field("keywords").querySelectorAll(".cw-chip").length, 2, "Enter while composing does not add");

    const radio = (label) => [...field("kind").querySelectorAll("label")].find((node) => node.textContent.trim() === label).querySelector("input");
    await click(radio("お知らせ"));
    await settle();
    assert.deepEqual(lastSave(fixture).values.kind, ["news"]);
    await click(radio("なし"));
    await settle();
    assert.deepEqual(lastSave(fixture).values.kind, []);
    const day = (label) => [...field("days").querySelectorAll("label")].find((node) => node.textContent.trim() === label).querySelector("input");
    await click(day("月")); await click(day("土")); await click(day("月"));
    await settle();
    assert.deepEqual(lastSave(fixture).values.days, ["sat"]);

    await type(field("eventAt").querySelector('input[type="datetime-local"]'), "2026-11-03T10:30");
    await settle();
    assert.equal(lastSave(fixture).values.eventAt, "2026-11-03T01:30:00.000Z");
    assert.equal(field("eventAt").querySelector("input").value, "2026-11-03T10:30");
    await press("開催日時を消す");
    await settle();
    assert.equal(lastSave(fixture).values.eventAt, null);
    await type(field("source").querySelector('input[type="url"]'), "https://example.test/a");
    await type(field("summary").querySelector("textarea"), "説明の文");
    await settle();
    assert.equal(lastSave(fixture).values.source, "https://example.test/a");
    assert.equal(lastSave(fixture).values.summary, "説明の文");

    const area = field("body").querySelector('[contenteditable="true"]');
    assert.equal(area.innerHTML, "<p>朝の海辺を歩きました。</p>");
    for (const name of ["段落", "見出し", "小見出し", "太字", "斜体", "箇条書き", "番号付き", "引用"]) await press(name, field("body"));
    await act(async () => { area.innerHTML = '<p onclick="x()">本文<script>bad()</script> <b>強く</b></p>'; area.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await settle();
    assert.equal(lastSave(fixture).values.body, "<p>本文 <strong>強く</strong></p>");
    await chooseFile(field("body").querySelector('input[type="file"]'), photo);
    await settle();
    assert.match(lastSave(fixture).values.body, /^<p>本文 <strong>強く<\/strong><\/p><p><img src="https:\/\/media\.example\.test\/upload-\d+\.jpg" alt="" width="1200" height="800"><\/p>$/u);
    await press("リンク", field("body"));
    await type(field("body").querySelector('input[type="url"]'), "javascript:alert(1)");
    await press("リンクにする", field("body"));
    assert.ok(field("body").querySelector(".cw-error").textContent.includes("https://"));

    const saved = lastSave(fixture).values;
    for (const key of ["category", "related", "keywords", "kind", "days"]) assert.ok(Array.isArray(saved[key]), key);
    for (const key of ["title", "body", "slug", "source", "summary"]) assert.equal(typeof saved[key], "string", key);
  } finally { await app.cleanup(); }
});

test("remove and unpublish only after confirmation, with focus returned; capabilities hide actions", async () => {
  const fixture = createAdapter();
  const app = await setup({ adapter: fixture.adapter });
  try {
    const menuButton = () => button("「海辺の朝さんぽ」の操作");
    await click(menuButton());
    assert.deepEqual([...document.querySelectorAll('[role="menu"] button')].map(nameOf), ["開く", "複製する", "非公開にする", "削除する"]);
    await press("削除する");
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog.textContent.includes("「海辺の朝さんぽ」を削除しますか？"));
    assert.ok(dialog.contains(document.activeElement));
    const dialogButtons = [...dialog.querySelectorAll("button")];
    dialogButtons.at(-1).focus();
    await key(dialogButtons.at(-1), "Tab");
    assert.equal(document.activeElement, dialogButtons[0], "Tab stays inside the dialog");
    await key(document.activeElement, "Escape");
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(fixture.named("remove").length, 0);
    assert.equal(document.activeElement, menuButton(), "focus returns to the menu button");
    await click(menuButton());
    await press("削除する");
    await press("削除する", document.querySelector('[role="dialog"]'));
    await flush();
    assert.deepEqual(fixture.named("remove")[0].input, { collectionId: "posts", itemId: "p1", version: "v1" });
    assert.ok(document.querySelector('.cw-toast[role="status"]').textContent.includes("削除しました。"));
    assert.equal(rowTitles().includes("海辺の朝さんぽ"), false);

    await openRow("工房の見学レポート");
    await press("その他の操作");
    assert.deepEqual([...document.querySelectorAll('[role="menu"] button')].map(nameOf), ["変更を取り消す", "非公開にする", "複製する", "削除する"]);
    await press("非公開にする");
    await press("やめる");
    assert.equal(fixture.named("unpublish").length, 0);
    await press("その他の操作");
    await press("非公開にする");
    await press("非公開にする", document.querySelector('[role="dialog"]'));
    await flush();
    assert.equal(fixture.named("unpublish").length, 1);
    assert.ok(document.querySelector('.cw-banner[role="status"]').textContent.includes("非公開にしました。"));

    await press("一覧へ");
    await press("サークル（3 件）");
    await openRow("将棋クラブ");
    assert.equal(button("その他の操作"), undefined, "no menu when every action is unavailable");
    assert.equal(document.querySelector(".cw-schedule"), null, "schedule hidden when capability is false");
  } finally { await app.cleanup(); }
});

test("forbidden clears content; adapter swap and close abort old reads and discard late responses", async () => {
  const forbidden = await setup({ adapter: createAdapter({ loadSchema: async () => ({ status: "forbidden" }) }).adapter });
  try {
    assert.ok(document.body.textContent.includes("コンテンツを見る権限がありません"));
    assert.equal(document.querySelector(".cw-nav"), null);
  } finally { await forbidden.cleanup(); }

  const listForbidden = await setup({ adapter: createAdapter({ listItems: async (input) => input.collectionId === "posts" ? { status: "forbidden" } : undefined }).adapter });
  try {
    assert.ok(document.querySelector(".cw-main").textContent.includes("記事を見る権限がありません"));
    assert.equal(rows().length, 0);
    assert.ok(document.querySelector(".cw-nav").textContent.includes("サークル"));
  } finally { await listForbidden.cleanup(); }

  let deny = false;
  const fixture = createAdapter({ saveDraft: async () => deny ? { status: "forbidden" } : undefined });
  const app = await setup({ adapter: fixture.adapter, autosaveDelay: 10, initialCollectionId: "posts", initialItemId: "p1" });
  try {
    deny = true;
    await type(document.querySelector('[data-field="title"] input'), "消える入力");
    await wait(40); await flush();
    assert.ok(document.body.textContent.includes("記事を見る権限がありません"));
    assert.equal(document.querySelector('[data-field="title"]'), null);
    assert.equal(document.body.textContent.includes("消える入力"), false);
  } finally { await app.cleanup(); }

  let finishOld, oldSignal;
  const old = createAdapter({ loadSchema: (_input, signal) => { oldSignal = signal; return new Promise((resolve) => { finishOld = resolve; }); } });
  const swapped = await setup({ adapter: old.adapter });
  try {
    const replacement = createAdapter({ loadSchema: async () => ({ ...schema(), collections: [schema().collections[1]] }) });
    await swapped.render({ adapter: replacement.adapter });
    assert.equal(oldSignal.aborted, true);
    await act(async () => finishOld(schema())); await flush();
    assert.deepEqual([...document.querySelectorAll(".cw-nav button")].map(nameOf), ["サークル（3 件）"], "late response from the old adapter is discarded");
  } finally { await swapped.cleanup(); }

  let itemSignal;
  const slow = createAdapter({ loadItem: (_input, signal) => { itemSignal = signal; return new Promise(() => {}); } });
  const closing = await setup({ adapter: slow.adapter, initialCollectionId: "posts", initialItemId: "p1" });
  await closing.cleanup();
  assert.equal(itemSignal.aborted, true);
});

test("leaving the editor saves first, restores row focus, and beforeunload guards unsaved edits", async () => {
  const fixture = createAdapter();
  const app = await setup({ adapter: fixture.adapter, autosaveDelay: 10_000 });
  try {
    await openRow("秋の読書会のお知らせ");
    await type(document.querySelector('[data-field="title"] input'), "秋の読書会（改）");
    const leave = new dom.window.Event("beforeunload", { cancelable: true });
    dom.window.dispatchEvent(leave);
    assert.equal(leave.defaultPrevented, true);
    await press("一覧へ");
    await flush();
    assert.equal(fixture.named("saveDraft").length, 1, "the waiting draft is saved before going back");
    assert.deepEqual(app.navigations.at(-1), { collectionId: "posts", itemId: null });
    assert.equal(document.activeElement.dataset.itemId, "p2");
    const after = new dom.window.Event("beforeunload", { cancelable: true });
    dom.window.dispatchEvent(after);
    assert.equal(after.defaultPrevented, false);

    await press("新しく書く");
    const created = fixture.named("createItem");
    assert.equal(created.length, 1);
    assert.equal(document.activeElement, document.querySelector('[data-field="title"] input'), "a new draft focuses its title");
    assert.equal(app.navigations.at(-1).itemId.startsWith("new"), true);
  } finally { await app.cleanup(); }
});
