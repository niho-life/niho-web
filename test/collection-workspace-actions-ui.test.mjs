import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { at, createAdapter, schemaWith, schema } from "./collection-fixtures.mjs";

// 並べ替え・まとめての操作・削除の移動先・アドレスの転送・gallery・予約のやり直し（U2-e）。値はすべて架空。
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://host.example.test/studio" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "PointerEvent", "DOMParser", "File"]) {
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
const click = async (target) => { assert.ok(target, "control not found"); await act(async () => target.click()); await flush(); };
const press = async (name, scope) => { const target = button(name, scope); assert.ok(target, `button ${name}`); await click(target); };
const valueSetter = (node) => Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value").set;
async function type(node, value) {
  assert.ok(node, "input not found");
  await act(async () => { valueSetter(node).call(node, value); node.dispatchEvent(new dom.window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); });
  await flush();
}
async function chooseFile(input, file) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
  await flush();
}
const field = (key) => document.querySelector(`[data-field="${key}"]`);
const rows = () => [...document.querySelectorAll(".cw-row")];
const rowTitles = () => rows().map((row) => row.querySelector(".cw-row-title").textContent);
const row = (title) => rows().find((node) => node.querySelector(".cw-row-title").textContent === title);
const menuNames = () => [...document.querySelectorAll('[role="menu"] button')].map(nameOf);
const checkbox = (name) => [...document.querySelectorAll('input[type="checkbox"]')].find((node) => (node.getAttribute("aria-label") || node.closest("label")?.textContent.trim()) === name);
const toast = () => document.querySelector(".cw-toast")?.textContent ?? "";
const lastSave = (fixture) => fixture.named("saveDraft").at(-1)?.input;

async function setup(props) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), navigations = [];
  const current = { onNavigate: (state) => navigations.push(state), ...props };
  await act(async () => root.render(createElement(CollectionWorkspace, current)));
  await flush();
  return { navigations, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function openRow(title) { await click(row(title)?.querySelector("button.cw-row-open")); }
async function openMenu(title) {
  // 開いているメニューを閉じてから開く（jsdom の click は外側の mousedown を出さない）
  for (const menu of document.querySelectorAll('[role="menu"]')) await act(async () => menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
  await press(`「${title}」の操作`);
}
const publishedCircle = (id, title, order) => ({ id, title, subtitle: null, imageUrl: null, path: `/circles/${id}`, status: "published", publishedAt: at, updatedAt: at, updatedBy: "編集担当（架空）",
  scheduledAt: null, publishFailed: false, order, version: "v1", values: { title, photo: null, host: "", slug: id } });

test("reorder: ordered rows get a handle and 上へ／下へ, drafts stay outside, results replace the list, 409 reloads", async () => {
  let conflict = false;
  const fixture = createAdapter({
    loadSchema: async () => schemaWith({ reorder: true }),
    reorder: async () => conflict ? { status: "conflict", items: [...fixture.store.circles.values()].map(({ version: _v, values: _values, ...summary }) => ({ ...summary, order: summary.id === "c4" ? 0 : summary.order })) } : undefined,
  });
  fixture.store.circles.set("c4", publishedCircle("c4", "読書会", 3));
  const app = await setup({ adapter: fixture.adapter, initialCollectionId: "circles" });
  try {
    assert.deepEqual(rowTitles(), ["写真散歩", "将棋クラブ", "朝ヨガの会", "読書会"], "draft-only rows first, then the order");
    assert.equal(document.querySelectorAll(".cw-handle").length, 3);
    assert.ok(row("写真散歩").querySelector(".cw-handle-slot"), "draft-only row has no handle");
    await openMenu("写真散歩");
    assert.deepEqual(menuNames(), ["開く"]);
    await openMenu("将棋クラブ");
    assert.deepEqual(menuNames(), ["開く", "下へ"]);
    await openMenu("朝ヨガの会");
    assert.deepEqual(menuNames(), ["開く", "上へ", "下へ"]);
    await press("下へ");
    await flush();
    assert.deepEqual(fixture.named("reorder")[0].input, { collectionId: "circles", ids: ["c2", "c1", "c4"], from: 1, to: 2 });
    assert.deepEqual(rowTitles(), ["写真散歩", "将棋クラブ", "読書会", "朝ヨガの会"]);
    assert.ok(toast().includes("並べ替えました。サイトに出るまで少しかかります。"));
    assert.equal(document.activeElement, button("「朝ヨガの会」の操作"), "focus follows the moved row");

    conflict = true;
    await openMenu("将棋クラブ");
    await press("下へ");
    await flush();
    assert.ok(toast().includes("ほかの人が先に並びを変えていました"));
    assert.deepEqual(rowTitles(), ["写真散歩", "読書会", "将棋クラブ", "朝ヨガの会"], "the list is replaced with the returned items");
    conflict = false;

    // ドラッグ: 行の位置を決めて、掴む印を指で下へ動かす
    const handleOf = (title) => row(title).querySelector(".cw-handle");
    rows().forEach((node, index) => { node.getBoundingClientRect = () => ({ top: index * 60, height: 60, bottom: index * 60 + 60, left: 0, right: 600, width: 600, x: 0, y: index * 60 }); });
    const pointer = (target, kind, clientY) => act(async () => target.dispatchEvent(new dom.window.PointerEvent(kind, { bubbles: true, cancelable: true, clientY, pointerId: 7, pointerType: "mouse", button: 0 })));
    const before = fixture.named("reorder").length;
    await pointer(handleOf("読書会"), "pointerdown", 90);
    await pointer(handleOf("読書会"), "pointermove", 220);
    assert.equal(row("朝ヨガの会").dataset.drop, "after", "the drop place is shown");
    await pointer(handleOf("読書会"), "pointerup", 220);
    await flush();
    assert.deepEqual(fixture.named("reorder")[before].input, { collectionId: "circles", ids: ["c4", "c2", "c1"], from: 0, to: 2 });

    // 検索・絞り込みの間は並べ替えない
    await type(document.querySelector(".cw-search input"), "会");
    assert.equal(document.querySelectorAll(".cw-handle").length, 0);
    assert.ok(document.body.textContent.includes("並べ替えは、検索と絞り込みをやめると使えます。"));
    await openMenu("朝ヨガの会");
    assert.deepEqual(menuNames(), ["開く"]);
  } finally { await app.cleanup(); }

  // capabilities が古い形（5 つ）なら、adapter に reorder があっても出さない
  const old = createAdapter();
  const plain = await setup({ adapter: old.adapter, initialCollectionId: "circles" });
  try {
    assert.equal(document.querySelectorAll(".cw-handle").length, 0);
    await openMenu("将棋クラブ");
    assert.deepEqual(menuNames(), ["開く"]);
  } finally { await plain.cleanup(); }
  const noMethod = createAdapter({ loadSchema: async () => schemaWith({ reorder: true }) });
  delete noMethod.adapter.reorder;
  const missing = await setup({ adapter: noMethod.adapter, initialCollectionId: "circles" });
  try { assert.equal(document.querySelectorAll(".cw-handle").length, 0); } finally { await missing.cleanup(); }
});

test("bulk: select rows or all, act after reading the latest versions, confirm deletes, show 422 near the bar, reload on 409", async () => {
  let mode = "ok";
  const fixture = createAdapter({
    loadSchema: async () => schemaWith({ bulk: true, redirects: true }),
    bulk: async () => mode === "invalid" ? { status: "invalid", errors: [{ field: "", message: "「秋の読書会のお知らせ」はアドレスが空なので公開できません。" }] }
      : mode === "conflict" ? { status: "conflict", items: [...fixture.store.posts.values()].map(({ version: _v, values: _values, ...summary }) => summary) } : undefined,
  });
  const app = await setup({ adapter: fixture.adapter });
  try {
    assert.equal(rows().filter((node) => node.querySelector('input[type="checkbox"]')).length, 5);
    await click(checkbox("全部を選ぶ"));
    assert.ok(document.querySelector(".cw-bulk").textContent.includes("5 件を選択中"));
    assert.equal(checkbox("全部を選ぶ").checked, true);
    await press("選択をやめる");
    assert.equal(button("公開する", document.querySelector(".cw-bulk")), undefined);
    assert.equal(document.activeElement, checkbox("全部を選ぶ"));

    await click(checkbox("「秋の読書会のお知らせ」を選ぶ"));
    await click(checkbox("「冬至のキャンドルナイト」を選ぶ"));
    assert.equal(checkbox("全部を選ぶ").indeterminate, true);
    const bar = () => document.querySelector(".cw-bulk");
    await press("公開する", bar());
    await flush();
    assert.deepEqual(fixture.named("loadItem").map((call) => call.input.itemId).sort(), ["p2", "p4"], "reads the latest version of each");
    assert.deepEqual(fixture.named("bulk")[0].input, { collectionId: "posts", action: "publish", items: [{ id: "p2", version: "v1" }, { id: "p4", version: "v1" }] });
    assert.ok(toast().includes("2 件を公開しました。サイトに出るまで少しかかります。"));
    assert.ok(row("秋の読書会のお知らせ").textContent.includes("反映中"), "the list is replaced with the result");
    assert.equal(bar().textContent.includes("件を選択中"), false, "the selection is cleared");

    mode = "invalid";
    await click(checkbox("「秋の読書会のお知らせ」を選ぶ"));
    await press("公開する", bar());
    await flush();
    const errors = document.querySelector(".cw-bulk-errors");
    assert.equal(errors.getAttribute("role"), "alert");
    assert.ok(errors.textContent.includes("まとめて公開できませんでした。"));
    assert.ok(errors.textContent.includes("アドレスが空なので公開できません"));
    assert.ok(bar().textContent.includes("1 件を選択中"), "the selection stays to fix and retry");

    mode = "conflict";
    await press("下書きに戻す", bar());
    assert.ok(document.querySelector('[role="dialog"]').textContent.includes("1 件を下書きに戻しますか？"));
    await press("下書きに戻す", document.querySelector('[role="dialog"]'));
    await flush();
    assert.equal(fixture.named("bulk").at(-1).input.action, "unpublish");
    assert.ok(toast().includes("ほかの人が先に変えました"));

    mode = "ok";
    await type(document.querySelector(".cw-search input"), "海辺");
    assert.equal(bar().textContent.includes("件を選択中"), false, "rows hidden by the search leave the selection");
    await click(checkbox("「海辺の朝さんぽ」を選ぶ"));
    await press("削除する", bar());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog.textContent.includes("1 件の記事を削除しますか？"));
    assert.ok(dialog.textContent.includes("公開中の項目のアドレスは一覧へ移します。"));
    await press("やめる", dialog);
    assert.equal(fixture.named("bulk").filter((call) => call.input.action === "remove").length, 0);
    await press("削除する", bar());
    await press("削除する", document.querySelector('[role="dialog"]'));
    await flush();
    const removed = fixture.named("bulk").at(-1).input;
    assert.equal(removed.action, "remove");
    assert.deepEqual(removed.items.map((entry) => entry.id), ["p1"]);
    assert.ok(toast().includes("1 件を削除しました。"));
  } finally { await app.cleanup(); }

  const old = await setup({ adapter: createAdapter().adapter });
  try {
    assert.equal(document.querySelector(".cw-bulk"), null, "old capabilities hide selection");
    assert.equal(rows()[0].querySelector('input[type="checkbox"]'), null);
  } finally { await old.cleanup(); }
});

test("remove offers where the old address goes when the host can redirect, and sends redirectTo only when chosen", async () => {
  const fixture = createAdapter({ loadSchema: async () => schemaWith({ redirects: true }) });
  const app = await setup({ adapter: fixture.adapter });
  try {
    await openMenu("海辺の朝さんぽ");
    await press("削除する");
    let dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog.querySelector("legend").textContent.includes("このアドレス（/posts/morning-walk）を開いた人の移動先"));
    const radios = () => [...document.querySelectorAll('[role="dialog"] input[type="radio"]')];
    assert.deepEqual(radios().map((node) => node.closest("label").textContent), ["一覧へ移す", "ほかの記事へ移す", "移さないこのアドレスを開いた人には「見つかりません」が出ます。"]);
    assert.equal(radios()[0].checked, true);
    await click(radios()[1]);
    const select = dialog.querySelector("select");
    assert.deepEqual([...select.options].map((option) => option.textContent), ["工房の見学レポート（/posts/workshop）"], "only other published or changed items with a path");
    await press("削除する", dialog);
    await flush();
    assert.deepEqual(fixture.named("remove")[0].input, { collectionId: "posts", itemId: "p1", version: "v1", redirectTo: "/posts/workshop" });

    await openMenu("工房の見学レポート");
    await press("削除する");
    await click(radios()[radios().length - 1]);
    await press("削除する", document.querySelector('[role="dialog"]'));
    await flush();
    assert.deepEqual(fixture.named("remove")[1].input, { collectionId: "posts", itemId: "p3", version: "v1", redirectTo: null });

    await openMenu("夏祭りのふりかえり");
    await press("削除する");
    await press("削除する", document.querySelector('[role="dialog"]'));
    await flush();
    assert.deepEqual(fixture.named("remove")[2].input, { collectionId: "posts", itemId: "p5", version: "v1" }, "the default sends no redirectTo");

    await openMenu("秋の読書会のお知らせ");
    await press("削除する");
    dialog = document.querySelector('[role="dialog"]');
    assert.equal(dialog.querySelector("fieldset"), null, "an unpublished item keeps the plain confirmation");
    assert.ok(dialog.textContent.includes("削除は元に戻せません。"));
    await press("やめる", dialog);
  } finally { await app.cleanup(); }

  const invalid = createAdapter({ loadSchema: async () => schemaWith({ redirects: true }), remove: async () => ({ status: "invalid", errors: [{ field: "", message: "移動先を選び直してください" }] }) });
  const editor = await setup({ adapter: invalid.adapter, initialCollectionId: "posts", initialItemId: "p1" });
  try {
    await press("その他の操作");
    await press("削除する");
    assert.ok(document.querySelector('[role="dialog"] fieldset'), "the editor offers the same choices");
    await press("削除する", document.querySelector('[role="dialog"]'));
    await flush();
    assert.ok(document.querySelector('.cw-banner[role="alert"]').textContent.includes("移動先を選び直してください"));
  } finally { await editor.cleanup(); }
});

test("changing a published address offers to move the old address, and publish and schedule send redirect only then", async () => {
  const fixture = createAdapter({ loadSchema: async () => schemaWith({ redirects: true }) });
  const app = await setup({ adapter: fixture.adapter, autosaveDelay: 10, initialCollectionId: "posts", initialItemId: "p1" });
  try {
    const slug = () => field("slug").querySelector('input[type="text"]');
    assert.equal(field("slug").querySelector('input[type="checkbox"]'), null, "nothing to ask before the address changes");
    await type(slug(), "walk-2026");
    const move = field("slug").querySelector('input[type="checkbox"]');
    assert.ok(move.closest("label").textContent.includes("前のアドレス（/posts/morning-walk）を開いた人を新しいアドレスへ移す"));
    assert.equal(move.checked, true);
    assert.equal(field("slug").textContent.includes("見つからなくなります"), false);
    await press("変更を公開する");
    await flush();
    assert.equal(fixture.named("publish")[0].input.redirect, true);
    assert.equal(field("slug").querySelector('input[type="checkbox"]'), null, "the new address is now the published one");

    fixture.store.posts.get("p1").status = "published"; // サイトの作り直しが終わった
    await type(slug(), "walk-autumn");
    await click(field("slug").querySelector('input[type="checkbox"]'));
    assert.ok(field("slug").textContent.includes("移さないと、前のアドレスを開いた人や検索結果からは見つからなくなります。"));
    await press("変更を公開する");
    await flush();
    assert.equal(fixture.named("publish")[1].input.redirect, false);
  } finally { await app.cleanup(); }

  const plain = createAdapter();
  const old = await setup({ adapter: plain.adapter, autosaveDelay: 10, initialCollectionId: "posts", initialItemId: "p1" });
  try {
    await type(field("slug").querySelector('input[type="text"]'), "walk-2026");
    assert.equal(field("slug").querySelector('input[type="checkbox"]'), null);
    assert.ok(field("slug").textContent.includes("見つからなくなります"), "hosts without redirects keep the warning");
    await press("変更を公開する");
    await flush();
    assert.equal(Object.hasOwn(plain.named("publish")[0].input, "redirect"), false);
  } finally { await old.cleanup(); }

  // 予約にも付ける（公開中の記事のアドレスを変えて予約する）
  const scheduled = createAdapter({ loadSchema: async () => schemaWith({ redirects: true }) });
  const later = await setup({ adapter: scheduled.adapter, autosaveDelay: 10, initialCollectionId: "posts", initialItemId: "p1" });
  try {
    await type(field("slug").querySelector('input[type="text"]'), "walk-later");
    await type(document.querySelector('.cw-schedule input[type="datetime-local"]'), "2099-11-03T10:30");
    await press("予約する");
    await flush();
    assert.equal(scheduled.named("schedule")[0].input.redirect, true);
    assert.equal(scheduled.named("schedule")[0].input.at, "2099-11-03T01:30:00.000Z");
  } finally { await later.cleanup(); }
});

test("gallery rows: add, upload with the collection id, caption, move, remove and the item limit keep the {id,image,caption} shape", async () => {
  const withGallery = () => {
    const value = schema();
    value.collections[1].fields.push({ key: "portfolio", label: "作品／活動", type: "gallery", captionLabel: "説明", placement: "main", maxItems: 3, captionMaxLength: 20 });
    return value;
  };
  const fixture = createAdapter({ loadSchema: async () => withGallery() });
  fixture.store.circles.get("c1").values.portfolio = [{ id: "w1", image: "https://media.example.test/w1.jpg", caption: "一つ目" }, { id: "w2", image: null, caption: "二つ目" }];
  const app = await setup({ adapter: fixture.adapter, autosaveDelay: 10, initialCollectionId: "circles", initialItemId: "c1" });
  const settle = async () => { await wait(40); await flush(); };
  try {
    const gallery = () => field("portfolio");
    assert.equal(gallery().getAttribute("role"), "group");
    assert.equal(gallery().querySelectorAll(".cw-gallery-row").length, 2);
    assert.equal(gallery().querySelector(".cw-gallery-row img").getAttribute("src"), "https://media.example.test/w1.jpg?w=320");
    assert.equal(button("1 件目を上へ").disabled, true);
    assert.equal(button("2 件目を下へ").disabled, true);
    assert.ok(gallery().textContent.includes("2 / 3 件"));

    await press("2 件目を上へ");
    await settle();
    assert.deepEqual(lastSave(fixture).values.portfolio.map((entry) => entry.id), ["w2", "w1"]);
    assert.equal(nameOf(document.activeElement), "1 件目を下へ", "focus stays on the moved row");

    await press("作品／活動を追加");
    await settle();
    assert.deepEqual(lastSave(fixture).values.portfolio.at(-1), { id: "", image: null, caption: "" });
    assert.equal(nameOf(document.activeElement), "3 件目の画像を選ぶ");
    assert.equal(button("作品／活動を追加"), undefined, "no add at maxItems");
    assert.ok(gallery().textContent.includes("これ以上は追加できません"));

    const photo = new File(["x"], "work.jpg", { type: "image/jpeg" });
    await chooseFile(gallery().querySelectorAll('input[type="file"]')[2], photo);
    assert.equal(fixture.named("uploadImage").at(-1).input.collectionId, "circles");
    await type(gallery().querySelectorAll("textarea")[2], "三つ目の説明");
    await settle();
    const third = lastSave(fixture).values.portfolio[2];
    assert.match(third.image, /^https:\/\/media\.example\.test\/upload-\d+\.jpg$/u);
    assert.equal(third.caption, "三つ目の説明");
    assert.equal(third.id, "");

    await press("1 件目を外す");
    await settle();
    assert.deepEqual(lastSave(fixture).values.portfolio.map((entry) => entry.id), ["w1", ""]);
    assert.ok(button("作品／活動を追加"));
    for (const entry of lastSave(fixture).values.portfolio) assert.deepEqual(Object.keys(entry).sort(), ["caption", "id", "image"]);
    const label = gallery().querySelector("textarea").labels[0];
    assert.ok(label.textContent.includes("説明"));
  } finally { await app.cleanup(); }
});

test("retrying a failed schedule shows only with the capability, the method, a schedule and a failed publish", async () => {
  const failing = () => { const fixture = createAdapter({ loadSchema: async () => schemaWith({ retrySchedule: true }) }); fixture.store.posts.get("p4").publishFailed = true; return fixture; };
  const fixture = failing();
  const app = await setup({ adapter: fixture.adapter, initialCollectionId: "posts", initialItemId: "p4" });
  try {
    assert.ok(document.querySelector(".cw-schedule").textContent.includes("予約していた公開に失敗しました。"));
    await press("もう一度公開する");
    await flush();
    assert.deepEqual(fixture.named("retrySchedule")[0].input, { collectionId: "posts", itemId: "p4", version: "v1" });
    assert.ok(document.querySelector('.cw-banner[role="status"]').textContent.includes("予約していた公開をやり直しました。"));
    assert.equal(button("もう一度公開する"), undefined, "the button goes once the publish is no longer failed");
  } finally { await app.cleanup(); }

  const old = createAdapter();
  old.store.posts.get("p4").publishFailed = true;
  const plain = await setup({ adapter: old.adapter, initialCollectionId: "posts", initialItemId: "p4" });
  try { assert.equal(button("もう一度公開する"), undefined, "old capabilities hide retry"); } finally { await plain.cleanup(); }

  const noMethod = failing();
  delete noMethod.adapter.retrySchedule;
  const missing = await setup({ adapter: noMethod.adapter, initialCollectionId: "posts", initialItemId: "p4" });
  try { assert.equal(button("もう一度公開する"), undefined); } finally { await missing.cleanup(); }

  const notFailed = createAdapter({ loadSchema: async () => schemaWith({ retrySchedule: true }) });
  const fine = await setup({ adapter: notFailed.adapter, initialCollectionId: "posts", initialItemId: "p4" });
  try { assert.equal(button("もう一度公開する"), undefined); } finally { await fine.cleanup(); }
});
