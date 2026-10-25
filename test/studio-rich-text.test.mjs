import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createAdapter, post } from "./collection-fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://studio.example.test/", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "DOMParser", "File", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment", "Range", "getSelection"]) {
  const value = typeof dom.window[key] === "function" && /^[a-z]/u.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// jsdom は配置を持たない。ProseMirror が位置を測る所だけ空の値を返す
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
dom.window.document.elementFromPoint = () => null;
// jsdom に ClipboardEvent が無い（ProseMirror の pasteHTML が作る）
globalThis.ClipboardEvent ??= class ClipboardEvent extends dom.window.Event { constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData ?? null; } };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** studio/ の TS を束ねて読み込む（TipTap は中に入れ、React は外のものを使う）。 */
async function loadStudioRichText() {
  const directory = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.tmp-studio-rich-text-"));
  const outfile = path.join(directory, "rich-text.mjs");
  try {
    await build({
      stdin: { contents: 'export * from "./studio/rich-text-editor.tsx"; export * from "./studio/rich-text-sanitize.ts"; export { studioRichTextCss } from "./studio/rich-text-style.ts";', resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
      bundle: true, external: ["react", "react/jsx-runtime", "react-dom"], format: "esm", platform: "node", target: "node22", outfile, logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
const { StudioRichTextEditor, createStudioRichText, sanitizeStudioRichTextHtml, isStudioRichTextSafe, studioRichTextCss } = await loadStudioRichText();
const { sanitizeRichTextHtml } = await import("../dist/collection-model.js");
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CollectionWorkspace } = await import("@niho/web/collection-workspace");

// STUDIO から移した形の本文（架空）: 図の style・見出しの id・目次の置き場・埋め込み・リンクの target と rel・空の width/height
const studio = '<h2 id="index_Dm8kQ2aL">はじめに</h2><p>架空の記事です。<a target="_blank" href="https://example.test/guide" rel="">案内</a>もどうぞ。</p><div></div>'
  + '<figure style="text-align: "><img src="https://media.example.test/a.jpg" alt="" width="" height=""><figcaption>架空の写真の説明</figcaption></figure>'
  + '<h3 id="index_Rt5vWx9P">当日の流れ</h3><p>午前は<strong>散歩</strong>、午後は<em>読書</em><u>でした</u>。<br>二行目です。</p>'
  + '<figure style=""><img src="https://media.example.test/b.jpg" alt="" width="" height=""><figcaption></figcaption></figure>'
  + '<div data-type="embed_code"><iframe src="https://video.example.test/embed/demo" width="560" height="315" title="架空の動画" allowfullscreen=""></iframe></div>'
  + '<h1 id="index_Yh3nBc7Q">まとめ</h1><ul><li>ひとつめ</li><li>ふたつめ</li></ul><hr><p>おわり。<a href="#index_Dm8kQ2aL" target="_blank" rel="noopener">はじめにへ</a></p>';
const danger = '<p onclick="steal()">あ<script>alert(1)</script><a href="javascript:alert(2)">い</a><img src="https://media.example.test/x.jpg" onerror="alert(3)"></p>'
  + '<figure style="background:url(https://evil.example.test/t.png)"><img src="https://media.example.test/c.jpg" alt=""><figcaption>う</figcaption></figure>'
  + '<div data-type="embed_code"><blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/demo/" onmouseover="alert(4)">え</blockquote><script async src="https://evil.example.test/embed.js"></script></div>'
  + '<iframe src="http://insecure.example.test/frame"></iframe><p>お</p>';

const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const flush = async () => { for (let index = 0; index < 4; index += 1) await wait(0); };
/** 共有の無害化（ワークスペースが props.sanitize として渡すもの）。"/media/" だけ同じサイトの画像を残す。 */
const workspaceSanitize = (html) => sanitizeRichTextHtml(html, { isImageSrcAllowed: (src) => src.startsWith("/media/") });

async function setup(props = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container), changes = [], uploads = [];
  let current = {
    id: "body-control", labelId: "body-label", describedBy: undefined, invalid: false, value: studio, sanitize: workspaceSanitize,
    onChange: (html) => { changes.push(html); current = { ...current, value: html }; },
    uploadImage: async (file) => { uploads.push(file); return { url: "https://media.example.test/new.jpg", width: 800, height: 600 }; },
    ...props,
  };
  const render = async (next = {}) => { current = { ...current, ...next }; await act(async () => root.render(createElement(StudioRichTextEditor, current))); await flush(); };
  await render();
  const editable = () => container.querySelector(".studio-rich-body");
  return {
    container, changes, uploads, render, editable,
    editor: () => editable().editor,
    // 値を親（ワークスペース）が受け取って描き直すのと同じにする
    sync: async () => render(),
    cleanup: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}
const textPos = (editor, text) => {
  let found = null;
  editor.state.doc.descendants((node, pos) => { if (found === null && node.isText && node.text.includes(text)) found = pos + node.text.indexOf(text); return found === null; });
  assert.notEqual(found, null, `text ${text}`);
  return found;
};
const typeAt = async (app, pos, text) => { await act(async () => { const editor = app.editor(); editor.view.dispatch(editor.state.tr.insertText(text, pos)); }); await app.sync(); };
const button = (container, name) => [...container.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === name || node.textContent.trim() === name);
const click = async (target) => { assert.ok(target, "button not found"); await act(async () => target.click()); await flush(); };
const parse = (html) => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;

test("sanitizer: STUDIO の本文の形はそのまま残り、共有の無害化と食い違わない", () => {
  assert.equal(sanitizeStudioRichTextHtml(studio), studio);
  assert.equal(isStudioRichTextSafe(studio), true);
  // 共有の無害化は見出しの id・図の style・埋め込み・目次の置き場・h1 を落とす（だから Studio は別の許可リストを使う）
  const shared = sanitizeRichTextHtml(studio);
  for (const lost of ['id="index_Dm8kQ2aL"', 'style="text-align: "', 'data-type="embed_code"', "<div></div>", "<h1"]) {
    assert.ok(studio.includes(lost) && !shared.includes(lost), lost);
  }
  // 共有の無害化が残す本文は、Studio の無害化でも同じに残る
  const plain = '<p>ふつうの<strong>本文</strong>と<em>強調</em>。<a href="https://example.test/">リンク</a><br>改行</p><h2>見出し</h2><ul><li>一</li></ul><ol><li>二</li></ol><blockquote><p>引用</p></blockquote><hr><figure><img src="https://media.example.test/p.jpg" alt="写真" width="640" height="480"><figcaption>説明</figcaption></figure>';
  assert.equal(sanitizeStudioRichTextHtml(plain), sanitizeRichTextHtml(plain));
  // "/" から始まる画像は isImageSrcAllowed が許したものだけ
  assert.equal(sanitizeStudioRichTextHtml('<p><img src="/media/a.png" alt=""></p>'), "<p></p>");
  assert.equal(sanitizeStudioRichTextHtml('<p><img src="/media/a.png" alt=""></p>', { isImageSrcAllowed: (src) => src.startsWith("/media/") }), '<p><img src="/media/a.png" alt=""></p>');
});

test("sanitizer: script・on 属性・javascript: のリンク・外の読み込みの style・http の iframe は残らない", () => {
  const out = sanitizeStudioRichTextHtml(danger);
  for (const bad of ["<script", "onclick", "onerror", "onmouseover", "javascript:", "url(", "http://insecure", "evil.example.test"]) assert.ok(!out.includes(bad), `${bad} in ${out}`);
  assert.equal(isStudioRichTextSafe(danger), false);
  const body = parse(out);
  assert.equal(body.querySelector("p").textContent, "あい");
  assert.equal(body.querySelector("figure").getAttribute("style"), null);
  // 埋め込みは枠と blockquote（class・data-*）を残し、script だけを落とす
  const embed = body.querySelector('div[data-type="embed_code"] > blockquote.instagram-media');
  assert.equal(embed.getAttribute("data-instgrm-permalink"), "https://www.instagram.com/p/demo/");
  assert.equal(body.querySelectorAll("iframe").length, 0);
  assert.equal(sanitizeStudioRichTextHtml('<div data-type="embed_code"><iframe src="https://video.example.test/e" allow="autoplay; camera; fullscreen" onload="x()"></iframe></div>'),
    '<div data-type="embed_code"><iframe src="https://video.example.test/e" allow="autoplay; fullscreen"></iframe></div>');
});

test("読み込んだだけでは onChange を呼ばず、図・目次・埋め込みを出し、ラベルと id を付ける", async () => {
  const app = await setup();
  try {
    assert.deepEqual(app.changes, []);
    const body = app.editable();
    assert.equal(body.id, "body-control");
    assert.equal(body.getAttribute("role"), "textbox");
    assert.equal(body.getAttribute("aria-labelledby"), "body-label");
    assert.equal(body.getAttribute("contenteditable"), "true");
    assert.equal(body.querySelectorAll("figure").length, 2);
    assert.equal(body.querySelector("figure img").getAttribute("src"), "https://media.example.test/a.jpg");
    assert.equal(body.querySelector("figure").getAttribute("style"), null, "編集画面では style を付けない（CSP）");
    assert.match(body.querySelector(".studio-rich-toc").textContent, /目次.*はじめに.*当日の流れ/u);
    assert.match(body.querySelector(".studio-rich-embed").textContent, /埋め込み/u);
    assert.equal(body.querySelector("iframe"), null, "埋め込みの中身は編集画面に出さない");
    await app.render({ invalid: true, describedBy: "body-error" });
    assert.equal(app.editable().getAttribute("aria-invalid"), "true");
    assert.equal(app.editable().getAttribute("aria-describedby"), "body-error");
    assert.deepEqual(app.changes, []);
  } finally { await app.cleanup(); }
});

test("1 文字直すと変わるのはその所だけ。戻すと読み込んだ値そのものに戻る", async () => {
  const app = await setup();
  try {
    const before = app.editor();
    await typeAt(app, textPos(app.editor(), "です。"), "★");
    assert.equal(app.editor(), before, "自分の変更で本文を作り直さない");
    assert.equal(app.changes.at(-1), studio.replace("架空の記事です。", "架空の記事★です。"));
    await act(async () => { app.editor().commands.undo(); });
    await app.sync();
    assert.equal(app.changes.at(-1), studio);
    // 見出しを直しても id は残る。図の説明を直しても style と画像の属性は残る
    await typeAt(app, textPos(app.editor(), "当日の流れ") + 2, "★");
    assert.equal(app.changes.at(-1), studio.replace("当日の流れ", "当日★の流れ"));
    await typeAt(app, textPos(app.editor(), "架空の写真の説明"), "★");
    assert.equal(app.changes.at(-1), studio.replace("当日の流れ", "当日★の流れ").replace("架空の写真の説明", "★架空の写真の説明"));
    // リンクのある段落を直しても、リンクの属性の並びは元のまま
    await typeAt(app, textPos(app.editor(), "おわり。") + 1, "★");
    assert.ok(app.changes.at(-1).endsWith('<p>お★わり。<a href="#index_Dm8kQ2aL" target="_blank" rel="noopener">はじめにへ</a></p>'), app.changes.at(-1).slice(-120));
  } finally { await app.cleanup(); }
});

test("本文の画像は uploadImage の URL で入り、上げている間は書き出さない。だめなら理由を出す", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const app = await setup({ uploadImage: async (file) => { app.uploads.push(file); await pending; return { url: "https://media.example.test/new.jpg", width: 800, height: 600 }; } });
  try {
    await act(async () => { const editor = app.editor(); editor.commands.setTextSelection(textPos(editor, "です。")); });
    const input = app.container.querySelector('input[type="file"]');
    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    await app.sync();
    assert.deepEqual(app.uploads, [file]);
    assert.ok(app.editable().querySelector("figure.is-uploading"), "上げている間の印");
    assert.ok(!app.changes.some((html) => html.includes("new.jpg") || html !== studio), "上げている間は値を変えない");
    release();
    await flush();
    await app.sync();
    const figure = '<figure style=""><img src="https://media.example.test/new.jpg" alt="" width="800" height="600"><figcaption></figcaption></figure>';
    const paragraph = '<p>架空の記事です。<a target="_blank" href="https://example.test/guide" rel="">案内</a>もどうぞ。</p>';
    assert.equal(app.changes.at(-1), studio.replace(paragraph, paragraph + figure));
  } finally { await app.cleanup(); }

  const refused = await setup({ uploadImage: async () => ({ error: "画像が大きすぎます。" }) });
  try {
    const input = refused.container.querySelector('input[type="file"]');
    Object.defineProperty(input, "files", { value: [new File(["x"], "big.jpg", { type: "image/jpeg" })], configurable: true });
    await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    await flush();
    assert.equal(refused.container.querySelector('[role="alert"]').textContent, "画像が大きすぎます。");
    assert.equal(refused.editable().querySelectorAll("figure").length, 2);
    assert.ok(refused.changes.every((html) => html === studio));
  } finally { await refused.cleanup(); }

  // "/" から始まる URL は、ワークスペースの sanitize が許すときだけ本文に入る。http は入らない
  for (const [url, ok] of [["/media/u-1.png", true], ["/private/u-1.png", false], ["http://media.example.test/n.jpg", false]]) {
    const local = await setup({ value: "<p>本文</p>", uploadImage: async () => ({ url }) });
    try {
      const input = local.container.querySelector('input[type="file"]');
      Object.defineProperty(input, "files", { value: [new File(["x"], "a.png", { type: "image/png" })], configurable: true });
      await act(async () => input.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
      await flush();
      if (ok) assert.equal(local.changes.at(-1), `<p>本文</p><figure style=""><img src="${url}" alt="" width="" height=""><figcaption></figcaption></figure>`);
      else { assert.deepEqual(local.changes, []); assert.equal(local.container.querySelector('[role="alert"]').textContent, "この画像は本文に入れられません。"); }
    } finally { await local.cleanup(); }
  }
});

test("危ない HTML は、読み込んでも貼り付けても、onChange の値に残らない", async () => {
  const app = await setup({ value: danger });
  try {
    assert.deepEqual(app.changes, [], "読み込んだだけでは書き換えない");
    assert.equal(app.editable().querySelector("script, iframe, [onclick], [onerror]"), null);
    await typeAt(app, textPos(app.editor(), "お"), "★");
    const edited = app.changes.at(-1);
    for (const bad of ["<script", "onclick", "onerror", "onmouseover", "javascript:", "url(", "http://insecure"]) assert.ok(!edited.includes(bad), `${bad} in ${edited}`);
    assert.ok(edited.includes("<p>★お</p>"));
    // 元に戻すと、読み込んだ値ではなく無害化した値に戻る
    await act(async () => { app.editor().commands.undo(); });
    await app.sync();
    assert.equal(app.changes.at(-1), sanitizeStudioRichTextHtml(danger));
    await act(async () => { app.editor().commands.setTextSelection(textPos(app.editor(), "お")); app.editor().view.pasteHTML('<p>貼<img src="https://media.example.test/y.jpg" onerror="alert(5)"><a href="javascript:alert(6)">る</a></p><script>alert(7)</script>'); });
    await app.sync();
    const pasted = app.changes.at(-1);
    assert.ok(pasted.includes("貼") && pasted.includes("る"), pasted);
    for (const bad of ["<script", "onerror", "javascript:"]) assert.ok(!pasted.includes(bad), `${bad} in ${pasted}`);
  } finally { await app.cleanup(); }
});

test("道具: 太字・見出し・リンク（使えないアドレスは断る）・目次は 1 つまで", async () => {
  const app = await setup({ value: "<p>あいうえお</p><p>かきくけこ</p>" });
  try {
    const select = (text, length) => act(async () => { const editor = app.editor(), from = textPos(editor, text); editor.commands.setTextSelection({ from, to: from + length }); });
    await select("いう", 2);
    await click(button(app.container, "太字"));
    assert.equal(app.changes.at(-1), "<p>あ<strong>いう</strong>えお</p><p>かきくけこ</p>");
    assert.equal(button(app.container, "太字").getAttribute("aria-pressed"), "true");
    await select("かき", 1);
    await click(button(app.container, "見出し"));
    assert.match(app.changes.at(-1), /^<p>あ<strong>いう<\/strong>えお<\/p><h2 id="index_[A-Za-z0-9]{8}">かきくけこ<\/h2>$/u);
    await select("えお", 2);
    await click(button(app.container, "リンク"));
    const input = app.container.querySelector("#body-control-link");
    const setValue = async (value) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await setValue("javascript:alert(1)");
    await click(button(app.container, "リンクにする"));
    assert.match(app.container.querySelector("#body-control-link-error").textContent, /https:\/\//u);
    await setValue("https://example.test/page");
    await click(button(app.container, "リンクにする"));
    const link = parse(app.changes.at(-1)).querySelector("a");
    assert.deepEqual([link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel"), link.textContent], ["https://example.test/page", "_blank", "noopener", "えお"]);
    await click(button(app.container, "目次"));
    assert.ok(app.changes.at(-1).includes("<div></div>"));
    await click(button(app.container, "目次"));
    assert.equal(app.container.querySelector('[role="status"]').textContent, "目次は 1 つだけです。すでに入っています。");
    assert.equal(app.changes.at(-1).match(/<div><\/div>/gu).length, 1);
  } finally { await app.cleanup(); }
});

test("埋め込みのコードは無害化して入れ、script は入れない", async () => {
  const app = await setup({ value: "<p>本文</p>" });
  try {
    await act(async () => { app.editor().commands.setTextSelection(3); });
    await click(button(app.container, "埋め込みを入れる"));
    const area = app.container.querySelector("#body-control-embed");
    const setCode = async (value) => act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(area, value); area.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await setCode('<script src="https://evil.example.test/x.js"></script>');
    await click(button(app.container, "入れる"));
    assert.match(app.container.querySelector("#body-control-embed-error").textContent, /入れられるものがありませんでした/u);
    await setCode('<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/demo/">投稿</blockquote><script async src="https://www.instagram.com/embed.js"></script>');
    await click(button(app.container, "入れる"));
    assert.equal(app.changes.at(-1), '<p>本文</p><div data-type="embed_code"><blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/demo/">投稿</blockquote></div>');
    assert.match(app.container.querySelector('[role="status"]').textContent, /<script> は入れていません/u);
    assert.match(app.editable().querySelector(".studio-rich-embed").textContent, /Instagram/u);
  } finally { await app.cleanup(); }
});

test("値が外から変わったら本文を読み直し、そのときは onChange を呼ばない", async () => {
  const app = await setup({ value: "<p>前の版</p>" });
  try {
    await app.render({ value: studio });
    assert.equal(app.editable().querySelectorAll("figure").length, 2);
    assert.deepEqual(app.changes, []);
    await typeAt(app, textPos(app.editor(), "はじめに"), "★");
    assert.equal(app.changes.at(-1), studio.replace(">はじめに</h2>", ">★はじめに</h2>"));
  } finally { await app.cleanup(); }
});

test("CollectionWorkspace の renderRichText に渡すと、本文の値を壊さずに保存する", async () => {
  const fixture = createAdapter({ loadItem: (input) => input.itemId === "p1" ? { status: "ready", item: post("p1", "海辺の朝さんぽ", {}, { slug: "morning-walk", body: studio }) } : undefined });
  const saves = [], adapter = { ...fixture.adapter, saveDraft: async (input, signal) => { saves.push(input.values.body); return fixture.adapter.saveDraft(input, signal); } };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(CollectionWorkspace, { adapter, initialCollectionId: "posts", initialItemId: "p1", autosaveDelay: 20, renderRichText: createStudioRichText() })));
    await flush();
    const body = container.querySelector(".studio-rich-body");
    assert.ok(body, "Studio の本文の部品が出る");
    assert.ok(body.id.endsWith("-body-control"), body.id);
    assert.equal(document.getElementById(body.getAttribute("aria-labelledby")).textContent.includes("本文"), true);
    await wait(60);
    assert.deepEqual(saves, [], "開いただけでは保存しない");
    await act(async () => { const editor = body.editor; editor.view.dispatch(editor.state.tr.insertText("★", textPos(editor, "おわり。"))); });
    await wait(80);
    assert.equal(saves.at(-1), studio.replace("おわり。", "★おわり。"));
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("CSS は Studio の束ねで studio.css に足すもの（inline の style を使わない）", () => {
  assert.match(studioRichTextCss, /\.studio-rich \.ProseMirror\{/u);
  assert.match(studioRichTextCss, /figcaption:empty::before/u);
});
