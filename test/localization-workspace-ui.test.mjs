import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createLocalizationMemory } from "../examples/localization-workspace-memory.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://studio.example.test/translations", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLIFrameElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "MessageEvent", "DOMParser", "File"]) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalizationWorkspace } = await import("@niho/web/localization-workspace");

const M = (id) => `⟦${id}⟧`;
const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const flush = async () => { for (let i = 0; i < 6; i++) await wait(0); };
/** 読み上げに近い名前（aria-label か、aria-hidden を除いた文字）。 */
const nameOf = (node) => {
  if (node.getAttribute("aria-label")) return node.getAttribute("aria-label");
  const copy = node.cloneNode(true);
  copy.querySelectorAll("[aria-hidden=true]").forEach((hidden) => hidden.remove());
  return copy.textContent.replace(/\s+/gu, " ").trim();
};
const buttons = (scope = document) => [...scope.querySelectorAll("button")];
const button = (name, scope = document) => buttons(scope).find((node) => nameOf(node) === name);
const click = async (target, label = "button") => { assert.ok(target, `${label} not found`); await act(async () => target.click()); await flush(); };
const press = async (name, scope) => click(button(name, scope), name);
async function key(node, keyName, options = {}) {
  let event;
  await act(async () => { event = new dom.window.KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...options }); node.dispatchEvent(event); });
  await flush();
  return event;
}
const rows = () => [...document.querySelectorAll(".lw-row")];
const rowTitles = () => rows().map((row) => row.querySelector(".cw-row-title").textContent);
const card = (unitId) => document.querySelector(`.lw-unit[data-unit-id="${unitId}"]`);
const input = (unitId) => card(unitId).querySelector(".lw-input");
const commands = (memory, action) => memory.named("command").filter((call) => !action || call.input.action === action);
const dialog = () => document.querySelector('[role="dialog"]');
async function edit(unitId, build) {
  const target = input(unitId);
  await act(async () => { build(target); target.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await flush();
}
const setText = (unitId, text) => edit(unitId, (target) => target.replaceChildren(document.createTextNode(text)));
const inputText = (unitId) => [...input(unitId).childNodes].map((node) => node.nodeType === 3 ? node.textContent : `[${node.getAttribute("data-mark")}]`).join("");

async function setup(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container), navigations = [];
  let current = { onNavigate: (state) => navigations.push(state), pollInterval: 10, ...props };
  const render = async (next = {}) => { current = { ...current, ...next }; await act(async () => root.render(createElement(LocalizationWorkspace, current))); await flush(); };
  await render();
  return { navigations, render, container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function openRow(title) {
  await click([...document.querySelectorAll("button.cw-row-open")].find((node) => node.querySelector(".cw-row-title").textContent === title), title);
}

test("list: staged loading, groups, band, filters, search and excluded reasons", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter });
  try {
    assert.deepEqual(memory.named("listItems").map((call) => call.input.cursor), [null, "p2", "p4"], "follows nextCursor until null");
    assert.deepEqual([...document.querySelectorAll(".cw-nav button")].map(nameOf), ["すべて（5 件）", "固定ページ（2 件・要対応 2 件）", "共通部分（1 件）", "記事（2 件・要対応 1 件）"]);
    const band = document.querySelector(".lw-band");
    assert.equal(band.querySelector("h2").textContent, "English版");
    assert.ok(band.textContent.includes("公開中：10/1 の公開"));
    assert.ok(band.textContent.includes("確認済み 1/4"));
    assert.ok(button("English版を公開…"));
    assert.deepEqual([...document.querySelectorAll(".cw-filters button")].map(nameOf), ["すべて（5 件）", "要対応（3 件）", "確認済み（1 件）", "対象外（1 件）"]);
    assert.equal(document.querySelector('.cw-filters button[aria-pressed="true"]').textContent.replace(/\s+/gu, " ").trim(), "要対応（3 件）");
    assert.deepEqual(rowTitles(), ["トップ", "私たちについて", "お知らせ一覧"]);
    await press("すべて（5 件）", document.querySelector(".cw-filters"));
    assert.deepEqual(rowTitles(), ["トップ", "私たちについて", "フッター", "お知らせ一覧", "会員向けのお知らせ"]);
    const byTitle = (title) => rows().find((row) => row.querySelector(".cw-row-title").textContent === title);
    assert.ok(byTitle("トップ").textContent.includes("未翻訳"));
    assert.ok(byTitle("トップ").querySelector(".lw-cell-reviewed").textContent.includes("0/3"));
    assert.ok(byTitle("私たちについて").textContent.includes("原文が更新"));
    assert.ok(byTitle("私たちについて").textContent.includes("原文に未公開の下書き"));
    assert.ok(byTitle("フッター").textContent.includes("確認済み"));
    assert.equal(byTitle("会員向けのお知らせ").querySelector(".cw-row-sub").textContent, "訳さない理由：会員だけが読むページなので訳しません。");
    assert.equal(document.querySelector(".lw-excluded").open, false, "対象外は通常の一覧では閉じている");
    assert.equal(document.querySelector(".lw-excluded summary").textContent.replace(/\s+/gu, " ").trim(), "対象外 1 件");
    assert.equal(byTitle("トップ").querySelector(".lw-source-link").getAttribute("href"), "https://cms.example.test/items/aG9tZQ");
    assert.equal(byTitle("トップ").querySelector(".lw-source-link").getAttribute("rel"), "noopener noreferrer");
    await click(document.querySelector(".lw-excluded summary"), "対象外");
    assert.equal(document.querySelector(".lw-excluded").open, true);
    for (const row of rows()) assert.ok(row.querySelector(".lw-pill .lw-shape"), "state has a shape as well as words");
    assert.ok(!document.body.textContent.includes("⟦"), "internal mark tokens are never shown");

    const filters = document.querySelector(".cw-filters");
    await press("要対応（3 件）", filters);
    assert.deepEqual(rowTitles(), ["トップ", "私たちについて", "お知らせ一覧"]);
    await press("対象外（1 件）", filters);
    assert.deepEqual(rowTitles(), ["会員向けのお知らせ"]);
    await press("すべて（5 件）", filters);
    const search = document.querySelector(".cw-search input");
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(search, "/members"); search.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    assert.deepEqual(rowTitles(), ["会員向けのお知らせ"], "search matches the address");
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(search, ""); search.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await press("共通部分（1 件）");
    assert.deepEqual(rowTitles(), ["フッター"]);
    assert.equal(document.querySelector(".cw-list-title h2").textContent, "共通部分");
  } finally { await app.cleanup(); }
});

test("source catalog advances automatically and reloads when current", async () => {
  const memory = createLocalizationMemory({ catalogRounds: 3 });
  const app = await setup({ adapter: memory.adapter });
  try {
    await wait(120);
    assert.equal(memory.named("advanceCatalog").length, 3, "the screen advances the catalog without a button");
    assert.ok(!document.querySelector(".lw-band").textContent.includes("原文を取り込んでいます"));
    assert.ok(memory.named("listItems").length >= 6, "the list is read again after the catalog is current");
  } finally { await app.cleanup(); }
});

test("editor: source and translation side by side, autosave about a second after typing, review and candidate", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter });
  try {
    await openRow("トップ");
    assert.deepEqual(app.navigations.at(-1), { view: "item", itemKey: "aG9tZQ" });
    assert.deepEqual([...document.querySelectorAll(".lw-unit")].map((node) => node.dataset.unitId), ["title", "lead", "body", "cover"]);
    assert.deepEqual([...card("title").querySelectorAll(".lw-col-label")].map((node) => node.textContent), ["日本語（読むだけ）", "English"]);
    assert.equal(card("title").querySelector(".lw-source .lw-text").textContent, "海の見える工房");
    assert.equal(inputText("title"), "Workshop by the sea");
    assert.equal(input("title").getAttribute("role"), "textbox");
    assert.equal(input("title").getAttribute("aria-multiline"), "false");
    assert.ok(input("title").getAttribute("aria-labelledby").split(" ").every((id) => document.getElementById(id)), "the input is labelled by the unit and the language");
    assert.ok(document.querySelector(".lw-section"), "sections are shown");
    assert.ok(document.body.textContent.includes("CMS で開く"));
    assert.equal(document.querySelector('.cw-editor-actions a').getAttribute("href"), "https://cms.example.test/items/aG9tZQ");

    await setText("title", "Workshop by");
    await setText("title", "Workshop by the sea!");
    assert.equal(document.querySelector(".cw-editor-status .cw-save-state").textContent, "保存中…");
    await wait(500);
    assert.equal(commands(memory).length, 0, "waits before saving");
    await wait(700);
    assert.equal(commands(memory).length, 1, "saves once");
    const sent = commands(memory)[0].input;
    assert.deepEqual({ ...sent, operationId: "x" }, { itemKey: "aG9tZQ", operationId: "x", unitId: "title", expectedVersion: "v1", expectedSourceVersion: "s1", action: "set-value", value: "Workshop by the sea!" });
    assert.match(sent.operationId, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(memory.state.items[0].units[0].value, "Workshop by the sea!");
    await flush();
    assert.equal(document.querySelector(".cw-editor-status .cw-save-state").textContent, "保存しました");

    await click(button("確認済みにする", card("title")), "review");
    assert.deepEqual({ ...commands(memory, "review-current")[0].input, operationId: "x" }, { itemKey: "aG9tZQ", operationId: "x", unitId: "title", expectedVersion: "v2", expectedSourceVersion: "s1", action: "review-current" });
    assert.ok(card("title").querySelector(".lw-unit-head").textContent.includes("確認済み"));
    assert.equal(button("確認済みにする", card("title")), undefined, "a reviewed unit has no review button");

    const lead = card("lead");
    assert.ok(lead.querySelector(".lw-candidate").textContent.includes("Open"));
    await click(button("翻訳案を使う", lead), "adopt");
    assert.equal(commands(memory, "adopt-candidate")[0].input.candidateId, "c-lead-1");
    assert.equal(inputText("lead"), "Open [m0]. Contact us at [m1].", "the input is rebuilt from the adopted candidate");
    assert.ok(card("lead").querySelector(".lw-unit-head").textContent.includes("未確認"));
    const row = await (async () => { await press("一覧へ"); return rows().find((entry) => entry.querySelector(".cw-row-title").textContent === "トップ"); })();
    assert.equal(document.activeElement, row.querySelector("button.cw-row-open"), "focus returns to the row");
    assert.ok(row.querySelector(".lw-cell-reviewed").textContent.includes("1/3"), "the row is updated from the command summary");
  } finally { await app.cleanup(); }
});

test("clear: the translation is cleared only after confirming, and the input is emptied", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter });
  try {
    await openRow("トップ");
    assert.equal(button("訳を消す", card("cover")), undefined, "images are put back with their own button");
    await click(button("訳を消す", card("title")), "clear");
    assert.ok(dialog().textContent.includes("この項目の訳を消しますか"));
    await press("やめる", dialog());
    assert.equal(commands(memory, "clear-value").length, 0, "cancel sends nothing");
    assert.equal(inputText("title"), "Workshop by the sea");
    await setText("title", "Workshop by the sea, unsaved");
    await click(button("訳を消す", card("title")), "clear");
    await press("訳を消す", dialog());
    assert.deepEqual({ ...commands(memory, "clear-value")[0].input, operationId: "x" }, { itemKey: "aG9tZQ", operationId: "x", unitId: "title", expectedVersion: "v1", expectedSourceVersion: "s1", action: "clear-value" });
    assert.equal(commands(memory, "set-value").length, 0, "the unsaved input is dropped, not saved first");
    assert.equal(inputText("title"), "", "the input is emptied");
    assert.ok(card("title").querySelector(".lw-unit-head").textContent.includes("未翻訳"));
    assert.equal(button("訳を消す", card("title")), undefined, "nothing left to clear");
    await wait(1300);
    assert.equal(commands(memory, "set-value").length, 0, "the dropped input is not saved later");
  } finally { await app.cleanup(); }
});

test("conflict: another editor's change or a new source is never overwritten", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter, autosaveDelay: 50 });
  try {
    await openRow("トップ");
    memory.externalEdit("aG9tZQ", "title", "Seaside workshop");
    await setText("title", "My title");
    await wait(120);
    assert.equal(commands(memory).length, 1);
    assert.equal(memory.state.items[0].units[0].value, "Seaside workshop", "the other editor's text stays");
    const box = card("title").querySelector(".lw-conflict");
    assert.ok(box.textContent.includes("ほかの人が先にこの項目を直しました"));
    assert.equal(inputText("title"), "My title", "my input stays on screen");
    await setText("title", "My title 2");
    await wait(120);
    assert.equal(commands(memory).length, 1, "no further saves while in conflict");
    await click(button("最新を読み込む", card("title")), "reload");
    assert.equal(inputText("title"), "Seaside workshop");
    await setText("title", "Seaside workshop!");
    await wait(120);
    assert.equal(commands(memory).at(-1).input.expectedVersion, "v2");
    assert.equal(memory.state.items[0].units[0].value, "Seaside workshop!");

    memory.changeSource("aG9tZQ", "title", "海の見える小さな工房");
    await setText("title", "Small workshop");
    await wait(120);
    assert.ok(card("title").querySelector(".lw-conflict").textContent.includes("原文が更新されました"));
    assert.equal(memory.state.items[0].units[0].value, "Seaside workshop!");
  } finally { await app.cleanup(); }
});

test("marks: chips cannot be deleted, a missing chip blocks saving, and chips may move", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter, autosaveDelay: 50 });
  try {
    await openRow("トップ");
    const chips = () => [...input("lead").querySelectorAll(".lw-mark")];
    assert.deepEqual(chips().map((chip) => chip.getAttribute("aria-label")), ["印「営業時間」", "印「メールアドレス」"], "a missing unit starts with the source chips");
    assert.ok(chips().every((chip) => chip.getAttribute("contenteditable") === "false"));
    assert.deepEqual([...card("lead").querySelectorAll(".lw-source .lw-mark")].map((chip) => chip.textContent.replace(/印「.*」$/u, "")), ["営業時間", "メールアドレス"]);
    assert.ok(!card("lead").textContent.includes("⟦"));

    await edit("lead", (target) => { const [first, second] = chips(); target.replaceChildren("Open ", first, ". Mail ", second, "."); });
    await wait(120);
    assert.equal(commands(memory, "set-value").at(-1).input.value, `Open ${M("m0")}. Mail ${M("m1")}.`);

    const after = input("lead").childNodes[2];
    await act(async () => { const selection = dom.window.getSelection(); selection.removeAllRanges(); const range = document.createRange(); range.setStart(after, 0); range.collapse(true); selection.addRange(range); });
    const backspace = await key(input("lead"), "Backspace");
    assert.equal(backspace.defaultPrevented, true, "Backspace next to a chip does nothing");
    assert.ok(card("lead").textContent.includes("札は消せません"));
    const typing = await key(input("lead"), "a");
    assert.equal(typing.defaultPrevented, false, "ordinary typing is not blocked");

    const saved = commands(memory).length;
    await edit("lead", () => chips()[1].remove());
    assert.ok(card("lead").querySelector(".cw-error").textContent.includes("札が足りません：メールアドレス"));
    assert.equal(input("lead").getAttribute("aria-invalid"), "true");
    await wait(150);
    assert.equal(commands(memory).length, saved, "a missing chip blocks saving");
    await click(button("札を元に戻す", card("lead")), "restore");
    assert.equal(chips().length, 2);
    assert.equal(card("lead").querySelector(".cw-error"), null);

    await edit("lead", (target) => { const [first, second] = chips(); target.replaceChildren(document.createTextNode("Mail "), second, document.createTextNode(", open "), first); });
    await wait(120);
    assert.equal(commands(memory, "set-value").at(-1).input.value, `Mail ${M("m1")}, open ${M("m0")}`, "chips can move");

    const rich = () => [...input("body").querySelectorAll(".lw-mark")];
    assert.deepEqual(rich().map((chip) => chip.textContent), ["〔リンク", "リンク〕"]);
    await edit("body", (target) => { const [open, close] = rich(); target.replaceChildren(open, "Click here", close, " for details."); });
    await wait(120);
    assert.deepEqual(commands(memory, "set-value").at(-1).input.value, { kind: "rich-text", children: [{ type: "element", id: "l1", tag: "a", children: [{ type: "text", text: "Click here" }] }, { type: "text", text: " for details." }] });
    await edit("body", (target) => { const [open, close] = rich(); target.replaceChildren(close, "x", open); });
    assert.ok(card("body").querySelector(".cw-error").textContent.includes("札の並びが原文と合いません"));
  } finally { await app.cleanup(); }
});

test("images: pick, review and go back to the source image", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter });
  try {
    await openRow("トップ");
    const cover = () => card("cover");
    assert.ok(cover().textContent.includes("日本語と同じ画像を使います。"));
    await click(button("素材から選ぶ", cover()), "pick");
    assert.deepEqual(commands(memory, "set-image")[0].input.image, { kind: "image-url", src: "https://media.example.test/cover-en.svg" });
    assert.equal(cover().querySelector(".lw-target img").getAttribute("src"), "https://media.example.test/cover-en.svg");
    await click(button("確認済みにする", cover()), "review image");
    assert.equal(commands(memory, "review-image").length, 1);
    await click(button("日本語と同じに戻す", cover()), "reset image");
    assert.equal(commands(memory, "set-image").at(-1).input.image, null);
    assert.ok(cover().textContent.includes("日本語と同じ画像を使います。"));
  } finally { await app.cleanup(); }
});

test("release: blockers stop the flow; prepare n/m, confirm with the time left, apply n/m", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter });
  try {
    await press("English版を公開…");
    let box = dialog();
    assert.ok(box.textContent.includes("まだ公開できません。次の 3 件を直してから"));
    assert.equal(button("準備を始める", box), undefined, "cannot proceed while there are reasons");
    assert.equal(memory.named("prepareRelease").length, 0);
    await click(buttons(box).find((node) => nameOf(node) === "開く"), "open blocker");
    assert.equal(dialog(), null);
    assert.deepEqual(app.navigations.at(-1), { view: "item", itemKey: "aG9tZQ" });
    await press("一覧へ");

    memory.setBlockers([]);
    await press("English版を公開…");
    box = dialog();
    assert.ok(box.textContent.includes("公開できない理由はありません"));
    await press("準備を始める", box);
    const prepares = memory.named("prepareRelease").map((call) => call.input);
    assert.equal(prepares.length, 3, "prepare is repeated with the resume token until ready");
    assert.deepEqual(prepares[0], { operation: "publish", releaseId: null, expectedVersion: "o1", expectedCurrentVersion: "r2", resumeToken: null });
    assert.match(prepares[1].resumeToken, /^prep-/);
    box = dialog();
    assert.ok(box.textContent.includes("https://example.test/en/"));
    assert.ok(box.textContent.includes("4 ページ"));
    assert.ok(box.textContent.includes("新しく出るページ（1）") && box.textContent.includes("私たちについて") && box.textContent.includes("外れるページ（0）"), "the pages that come and go are listed");
    assert.match(box.querySelector('[role="timer"]').textContent, /残り [12]:\d\d/);
    assert.ok(!box.textContent.includes("confirm-"), "the confirmation token is not shown");
    await press("English版を公開する", box);
    const applies = memory.named("applyRelease").map((call) => call.input);
    assert.equal(applies.length, 2);
    assert.match(applies[0].confirmationToken, /^confirm-/);
    assert.equal(applies[0].resumeToken, null);
    assert.deepEqual({ ...applies[1], resumeToken: "x" }, { confirmationToken: null, resumeToken: "x" });
    assert.ok(dialog().textContent.includes("English版を公開しました（今回の公開）"));
    await key(document.activeElement, "Escape");
    assert.equal(dialog(), null);
    assert.ok(document.querySelector(".lw-band").textContent.includes("公開中：今回の公開"));
  } finally { await app.cleanup(); }
});

test("release: an interrupted publish resumes from the band, and the confirmation can expire", async () => {
  const memory = createLocalizationMemory({ pending: "apply" });
  const app = await setup({ adapter: memory.adapter });
  try {
    const band = document.querySelector(".lw-band");
    assert.ok(band.textContent.includes("前回の公開が途中です。"));
    assert.equal(button("English版を公開…").disabled, true, "no new publish while one is in progress");
    await press("続ける", band);
    assert.deepEqual(memory.named("applyRelease")[0].input, { confirmationToken: null, resumeToken: "apply-1" });
    assert.ok(dialog().textContent.includes("English版を公開しました"));
    await press("閉じる", dialog());
  } finally { await app.cleanup(); }

  const second = createLocalizationMemory({ planTtl: 1100 });
  second.setBlockers([]);
  const other = await setup({ adapter: second.adapter });
  try {
    const held = second.hold("prepareRelease", 1);
    await press("English版を公開…");
    await press("準備を始める", dialog());
    assert.ok(dialog().textContent.includes("準備 1/3"), "the second round is still running");
    // 途中で閉じる → 帯の「続ける」から resumeToken で続ける
    await key(document.activeElement, "Escape");
    assert.equal(dialog(), null);
    await flush();
    const band = document.querySelector(".lw-band");
    assert.ok(band.textContent.includes("前回の公開が途中です。"), band.textContent);
    await press("続ける", band);
    const resumed = second.named("prepareRelease").at(-1).input;
    assert.match(resumed.resumeToken, /^prep-/);
    assert.ok(dialog().textContent.includes("準備ができました"));
    await wait(1600);
    assert.ok(dialog().textContent.includes("確認の期限が切れました"));
    assert.ok(button("準備し直す", dialog()));
    await act(async () => held.release());
    await flush();
    assert.ok(dialog().textContent.includes("確認の期限が切れました"), "the late response of the closed dialog is ignored");
  } finally { await other.cleanup(); }
});

test("release: roll back by choosing a version from the history", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter });
  try {
    await press("公開の履歴");
    const box = dialog();
    assert.ok(box.textContent.includes("10/1 の公開"));
    assert.ok(box.textContent.includes("公開中"));
    assert.ok(box.textContent.includes("9/15 の公開"));
    await press("「9/15 の公開」に戻す…", box);
    assert.ok(dialog().textContent.includes("「9/15 の公開」"));
    await press("準備を始める", dialog());
    assert.equal(memory.named("prepareRelease")[0].input.operation, "rollback");
    assert.equal(memory.named("prepareRelease")[0].input.releaseId, "en-2026-09-15");
    assert.ok(dialog().textContent.includes("戻す版"));
    await press("この版に戻す", dialog());
    assert.ok(dialog().textContent.includes("「9/15 の公開」に戻しました。"));
  } finally { await app.cleanup(); }
});

test("permissions: the site's list of allowed actions decides what the screen shows", async () => {
  const editor = createLocalizationMemory({ permissions: ["edit", "review", "translate"] });
  let app = await setup({ adapter: editor.adapter });
  try {
    assert.equal(button("English版を公開…"), undefined, "editors cannot publish");
    await press("公開の履歴");
    assert.equal(buttons(dialog()).filter((node) => nameOf(node).endsWith("に戻す…")).length, 0, "editors cannot roll back");
    await press("閉じる", dialog());
    await press("設定");
    assert.ok(document.body.textContent.includes("設定を変える権限がありません"));
    assert.equal(document.querySelector('.lw-settings input[type="checkbox"]').disabled, true);
    assert.equal(button("保存する"), undefined);
  } finally { await app.cleanup(); }

  const viewer = createLocalizationMemory({ permissions: [] });
  app = await setup({ adapter: viewer.adapter });
  try {
    await openRow("トップ");
    assert.ok(document.body.textContent.includes("訳文を直す権限がありません"));
    assert.equal(input("title").getAttribute("aria-readonly"), "true");
    assert.equal(input("title").getAttribute("contenteditable"), "false");
    assert.equal(button("確認済みにする"), undefined);
    assert.equal(button("翻訳案を作る"), undefined);
    assert.equal(button("翻訳案を使う"), undefined);
    assert.equal(button("素材から選ぶ"), undefined);
    await setText("title", "typed anyway");
    await wait(1200);
    assert.equal(commands(viewer).length, 0, "read-only inputs never save");
  } finally { await app.cleanup(); }

  const owner = createLocalizationMemory();
  app = await setup({ adapter: owner.adapter, initialView: "settings" });
  try {
    const checkbox = document.querySelector('.lw-settings input[type="checkbox"]');
    await click(checkbox, "checkbox");
    await press("保存する");
    assert.deepEqual(owner.named("saveSettings")[0].input, { expectedVersion: "set1", autoDraft: false });
    assert.ok(document.body.textContent.includes("保存しました。"));
  } finally { await app.cleanup(); }

  const denied = createLocalizationMemory();
  denied.state.forbidden = true;
  app = await setup({ adapter: denied.adapter });
  try { assert.ok(document.body.textContent.includes("翻訳を見る権限がありません")); } finally { await app.cleanup(); }
});

test("stale responses: a late item, list or adapter response is dropped", async () => {
  const memory = createLocalizationMemory();
  const app = await setup({ adapter: memory.adapter });
  try {
    const held = memory.hold("loadItem");
    await openRow("トップ");
    assert.ok(document.body.textContent.includes("読み込んでいます…"));
    await press("一覧へ");
    await openRow("私たちについて");
    assert.ok(card("intro"), "the second item is open");
    await act(async () => held.release());
    await flush();
    assert.equal(card("lead"), null, "the first item's late response is ignored");
    assert.ok(card("intro"));
    assert.ok(document.querySelector(".lw-changed").textContent.includes("原文が更新された項目（1）"), "changed units are shown first");
    assert.ok(card("intro").querySelector("details").textContent.includes("小さな町の工房です。"));
    assert.ok(document.body.textContent.includes("まだ公開していない下書きがあります"));
  } finally { await app.cleanup(); }

  const slow = createLocalizationMemory();
  const fresh = createLocalizationMemory({ permissions: ["edit"] });
  const holdList = slow.hold("listItems");
  const other = await setup({ adapter: slow.adapter });
  try {
    await other.render({ adapter: fresh.adapter });
    await act(async () => holdList.release());
    await flush();
    assert.deepEqual(rowTitles(), ["トップ", "私たちについて", "お知らせ一覧"]);
    assert.equal(button("English版を公開…"), undefined, "the new adapter's permissions are used");
    assert.equal(slow.named("listItems").length, 1, "the old adapter is not followed further");
  } finally { await other.cleanup(); }
});

test("translation job and preview frame", async () => {
  const memory = createLocalizationMemory({ frameUrl: "https://frame.example.test/render" });
  const app = await setup({ adapter: memory.adapter, autosaveDelay: 2000 });
  try {
    await openRow("トップ");
    const frame = document.querySelector("iframe.lw-frame");
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts");
    assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    const nonce = /#niho-preview=([A-Za-z0-9_-]{32})$/u.exec(frame.getAttribute("src"))[1];
    assert.deepEqual(memory.named("loadPreview").map((call) => call.input.cursor), [null, "units"]);
    const posted = [];
    frame.contentWindow.postMessage = (message, origin) => posted.push({ message, origin });
    const ready = { type: "niho-localization-preview", protocol: 1, nonce, event: "ready" };
    await act(async () => window.dispatchEvent(new dom.window.MessageEvent("message", { data: ready, source: window })));
    await wait(200);
    assert.equal(posted.length, 0, "messages from another window are ignored");
    await act(async () => window.dispatchEvent(new dom.window.MessageEvent("message", { data: { ...ready, nonce: "x".repeat(32) }, source: frame.contentWindow })));
    await wait(200);
    assert.equal(posted.length, 0, "a wrong nonce is ignored");
    await act(async () => window.dispatchEvent(new dom.window.MessageEvent("message", { data: ready, source: frame.contentWindow })));
    await wait(200);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].origin, "*");
    assert.equal(posted[0].message.event, "render");
    assert.equal(posted[0].message.locale, "en");
    assert.equal(posted[0].message.materials.length, 2);
    await setText("title", "Unsaved title");
    await wait(200);
    const override = (unitId) => posted.at(-1).message.overrides.find((entry) => entry.unitId === unitId);
    assert.deepEqual(override("title"), { unitId: "title", value: "Unsaved title" }, "unsaved input is shown in the preview");
    assert.deepEqual(override("lead"), { unitId: "lead", value: null });
    assert.equal(posted.at(-1).message.overrides.length, 4, "every unit's current value is sent");
    assert.equal(commands(memory).length, 0);
    await press("360");
    await wait(200);
    assert.equal(posted.at(-1).message.width, 360);
    await press("日本語", document.querySelector(".lw-preview"));
    await wait(200);
    assert.equal(posted.at(-1).message.locale, "ja");
    assert.deepEqual(posted.at(-1).message.overrides, []);

    await press("翻訳案を作る");
    await wait(80);
    assert.equal(memory.named("requestTranslation").length, 1);
    assert.ok(memory.named("readJob").length >= 2);
    assert.ok(document.body.textContent.includes("翻訳案ができました"));
    assert.ok(card("body").querySelector(".lw-candidate").textContent.includes("[EN] 詳しくは"));
    assert.equal(inputText("title"), "Unsaved title", "reloading after the job keeps unsaved input");
    await press("一覧へ");
    assert.equal(commands(memory, "set-value").at(-1).input.value, "Unsaved title", "going back saves first");
  } finally { await app.cleanup(); }
});
