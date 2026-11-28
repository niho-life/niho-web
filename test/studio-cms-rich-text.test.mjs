import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parsePageDocument } from "../dist/document.js";

const bundle = await build({
  stdin: { contents: 'export * from "./studio/managed-cms-rich-text.ts"; export { escapeHtml } from "./studio/managed-cms-model.ts";',
    resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
  bundle: true, format: "esm", platform: "node", target: "node22", write: false
});
const { cmsRichTextNodes, cmsRichTextPlainText, cmsRichTextProjection, decodeCmsReleaseRichText, escapeHtml, renderCmsRichTextHtml } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);

const convert = (html) => {
  let counter = 0;
  return cmsRichTextNodes(html, () => `rich-${++counter}`);
};
const render = (html) => renderCmsRichTextHtml(convert(html), () => true);
const pageWith = (html) => parsePageDocument({ schemaVersion: 1, siteId: "site", pageId: "page", locale: "ja", revision: 1, title: "Title", tokens: {},
  body: [{ type: "element", id: "body", tag: "div", children: convert(html) }] });

test("CMS rich text keeps formatting and passes the page document rules", () => {
  const html = '<h1 id="index_top">見出し</h1><h5 id="other">小見出し</h5><p>本文<br><b>太字</b><i>斜体</i></p>'
    + '<ul>前置き<li>一つ<ul><li>入れ子</li></ul></li></ul><ol><li>順序</li></ol><blockquote><p>引用</p></blockquote>'
    + '<figure><img src="https://media.example.test/a.webp" alt="写真" width="640" height="480"><figcaption>説明</figcaption></figure>'
    + '<p><a href="https://example.test/" target="_blank">外部</a><a href="/contact">内部</a><a href="#index_top">目次</a></p>';
  assert.equal(render(html), '<h2 id="index_top">見出し</h2><h4>小見出し</h4><p>本文<br><strong>太字</strong><em>斜体</em></p>'
    + '<ul><li>前置き</li><li>一つ<ul><li>入れ子</li></ul></li></ul><ol><li>順序</li></ol><blockquote><p>引用</p></blockquote>'
    + '<figure><img src="https://media.example.test/a.webp" alt="写真" width="640" height="480"><figcaption>説明</figcaption></figure>'
    + '<p><a href="https://example.test/" target="_blank" rel="noopener">外部</a><a href="/contact">内部</a><a href="#index_top">目次</a></p>');
  pageWith(html);
});

test("CMS rich text drops active content and unsafe URLs", () => {
  const html = '<script>alert(1)</script><style>p{}</style><iframe src="https://evil.example.test/"></iframe><svg><script>alert(2)</script></svg>'
    + '<form action="/x"><input name="a"></form><p onclick="alert(3)" style="color:red">残る<a href="javascript:alert(4)">リンク</a></p>'
    + '<img src="data:image/png;base64,AAAA" alt="x"><img src="http://insecure.example.test/a.png"><img src="x" onerror="alert(5)">'
    + '<a href="//evil.example.test/">相対</a><math><mi>x</mi></math><template><p>隠す</p></template>';
  const output = render(html);
  assert.equal(output, "<p>残るリンク</p>相対");
  assert.doesNotMatch(output, /alert|script|iframe|javascript|onerror|onclick|data:/u);
  pageWith(html);
});

test("CMS rich text normalizes nesting that the page document does not allow", () => {
  const html = '<p>段落<span><div>中の区切り</div></span></p><a href="/a"><a href="/b">二重</a></a><li>一覧の外</li>'
    + '<table><tbody><tr><th>項目</th><td>値</td></tr></tbody></table><h2><ul><li>見出し内の一覧</li></ul></h2>'
    + "<div>".repeat(60) + "深い入れ子" + "</div>".repeat(60);
  const document = pageWith(html);
  assert.match(cmsRichTextPlainText(document.body), /段落.*中の区切り.*二重.*一覧の外.*項目 値.*見出し内の一覧.*深い入れ子/u);
});

test("CMS rich text survives pathological nesting and never repeats a heading ID on one page", () => {
  for (const tag of ["div", "span", "ul", "table"]) {
    const html = `<${tag}>`.repeat(5_000) + "底の文字" + `</${tag}>`.repeat(5_000);
    assert.match(cmsRichTextPlainText(pageWith(html).body), /底の文字/u, tag);
  }
  const project = cmsRichTextProjection({ released: true });
  let counter = 0;
  const newId = () => `rich-${++counter}`, value = escapeHtml('<h2 id="index_a">題</h2>');
  const nodes = [...project(value, newId), ...project(value, newId)];
  assert.deepEqual(nodes.map((node) => node.attrs?.id), ["index_a", undefined]);
});

test("CMS release rich text is decoded once and rendered with escaped text and allowed images", () => {
  const source = '<p>"引用" &amp; &lt;記号&gt;</p><img src="https://blocked.example.test/a.png" alt="x">';
  assert.equal(decodeCmsReleaseRichText(escapeHtml(source)), source);
  assert.equal(renderCmsRichTextHtml(convert(source), () => false), "<p>&quot;引用&quot; &amp; &lt;記号&gt;</p>");
  assert.equal(cmsRichTextPlainText(convert("<h2>題</h2><p>本文</p>")), "題 本文");
});
