import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { readEditableChildren } from "../dist/editor-rich-text.js";

test("キャンバスで表示用URLを解決したリンクの文字だけを編集しても原稿URLを保持する", () => {
  const original = { type: "element", id: "text", tag: "p", children: [
    { type: "element", id: "link", tag: "a", name: "リンクのレイヤー名", attrs: { href: "/old?from=page#part" }, children: [{ type: "text", text: "元の文字" }] },
  ] };
  const links = { origin: "https://example.test", sourcePath: "/other", paths: { "/old": "/new" } };
  const dom = new JSDOM('<p><a data-nw-node="link" href="/new?from=page#part">変更した文字</a></p>');
  const root = dom.window.document.querySelector("p");
  const [updated] = readEditableChildren(root, original, links);
  assert.equal(updated.attrs.href, "/old?from=page#part");
  assert.equal(updated.name, "リンクのレイヤー名");
  root.querySelector("a").setAttribute("href", "/different");
  assert.equal(readEditableChildren(root, original, links)[0].attrs.href, "/different", "明示的なリンク変更は保持する");
});
