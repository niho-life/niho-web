import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  collectionDateFromInput, collectionDateInputValue, collectionItemFilter, collectionReorderSequence, moveCollectionIds, parseCollectionBulkResult,
  parseCollectionCreateResult, parseCollectionEnglishPublicationsReadResult, parseCollectionEnglishPublicationsRetryResult, parseCollectionItemResult, parseCollectionListResult, parseCollectionPublishResult, parseCollectionRemoveResult,
  parseCollectionReorderResult, parseCollectionSaveResult, parseCollectionSchemaResult, parseCollectionUploadResult, parseCollectionValues,
  sanitizeRichTextHtml, sortCollectionItems, validateCollectionValues,
} from "@niho/web/collection-model";
import { circlesDefinition, post, postsDefinition, schema, seed, tagsDefinition, toSummary } from "./collection-fixtures.mjs";

globalThis.DOMParser = new JSDOM("").window.DOMParser;
const posts = () => parseCollectionSchemaResult(schema()).collections[0];
const withPosts = (mutate) => { const input = schema(); mutate(input.collections[0]); return input; };

test("schema parses definitions in field order and rejects malformed or unsafe definitions", () => {
  const result = parseCollectionSchemaResult(schema());
  assert.equal(result.status, "ready");
  assert.deepEqual(result.collections.map((definition) => definition.id), ["posts", "circles", "tags"]);
  assert.deepEqual(result.collections[0].fields.map((field) => field.key), postsDefinition().fields.map((field) => field.key));
  assert.deepEqual(parseCollectionSchemaResult({ status: "forbidden" }), { status: "forbidden" });
  const bad = [
    [(definition) => { definition.fields.push({ ...definition.fields[0] }); }, /duplicate field key/u],
    [(definition) => { definition.fields[0].type = "html"; }, /unknown field type/u],
    [(definition) => { definition.fields[0].extra = true; }, /unknown field/u],
    [(definition) => { definition.titleField = "cover"; }, /field type does not fit/u],
    [(definition) => { definition.slugField = "title"; }, /field type does not fit/u],
    [(definition) => { definition.imageField = "missing"; }, /unknown field/u],
    [(definition) => { definition.fields[4].collectionId = "nowhere"; }, /unknown collection/u],
    [(definition) => { definition.fields[0].key = "__proto__"; definition.titleField = "__proto__"; }, /invalid key/u],
    [(definition) => { definition.fields[7].options = []; }, /select needs options/u],
    [(definition) => { definition.fields[7].options.push({ id: "news", label: "重複" }); }, /duplicate option/u],
    [(definition) => { definition.fields[0].placement = "footer"; }, /invalid placement/u],
    [(definition) => { definition.pathPrefix = "https://evil.example.test/"; }, /invalid path prefix/u],
    [(definition) => { definition.capabilities.publishAll = true; }, /unknown field/u],
    [(definition) => { delete definition.capabilities.schedule; }, /expected a boolean/u],
    [(definition) => { definition.ordering = "random"; }, /invalid ordering/u],
  ];
  for (const [mutate, pattern] of bad) assert.throws(() => parseCollectionSchemaResult(withPosts(mutate)), pattern);
  const duplicate = schema(); duplicate.collections.push(tagsDefinition());
  assert.throws(() => parseCollectionSchemaResult(duplicate), /duplicate collection/u);
  assert.throws(() => parseCollectionSchemaResult({ status: "ready", collections: [], extra: 1 }), /unknown field/u);
});

test("list results are identity-bound summaries with checked dates, paths and statuses", () => {
  const items = [...seed().posts.values()].map(toSummary);
  const result = parseCollectionListResult({ status: "ready", collectionId: "posts", items }, "posts");
  assert.equal(result.items.length, 5);
  assert.throws(() => parseCollectionListResult({ status: "ready", collectionId: "circles", items }, "posts"), /collection identity mismatch/u);
  assert.throws(() => parseCollectionListResult({ status: "ready", collectionId: "posts", items: [items[0], items[0]] }, "posts"), /duplicate item/u);
  const cases = [
    [{ status: "scheduled", scheduledAt: null }, /needs scheduledAt/u],
    [{ status: "archived" }, /invalid status/u],
    [{ publishedAt: "2026-10-20" }, /ISO timestamp/u],
    [{ updatedAt: "2026-02-30T00:00:00Z" }, /ISO timestamp/u],
    [{ path: "posts/x" }, /path must start/u],
    [{ path: "//evil.example.test/x" }, /path must start/u],
    [{ order: Number.NaN }, /finite number/u],
    [{ publishFailed: "no" }, /boolean/u],
    [{ id: "../x" }, /invalid item id/u],
    [{ secret: "x" }, /unknown field/u],
  ];
  for (const [patch, pattern] of cases) assert.throws(() => parseCollectionListResult({ status: "ready", collectionId: "posts", items: [{ ...items[0], ...patch }] }, "posts"), pattern);
  assert.deepEqual(parseCollectionListResult({ status: "forbidden" }, "posts"), { status: "forbidden" });
});

test("item values are normalized to the definition and wrong shapes throw", () => {
  const definition = posts();
  const loaded = parseCollectionItemResult({ status: "ready", item: { ...seed().posts.get("p2"), values: { title: "秋", slug: "book-club", legacy: "残す値はホストが持つ" } } }, definition, "p2");
  assert.deepEqual(loaded.item.values, { title: "秋", cover: null, body: "", slug: "book-club", category: [], related: [], keywords: [], kind: [], days: [], eventAt: null, source: "", summary: "" });
  assert.equal(Object.hasOwn(loaded.item.values, "legacy"), false);
  assert.throws(() => parseCollectionItemResult({ status: "ready", item: seed().posts.get("p1") }, definition, "p2"), /identity mismatch/u);
  const wrong = [
    [{ title: 1 }, /invalid text/u],
    [{ kind: "news" }, /expected an array/u],
    [{ kind: ["news", "report"] }, /single choice/u],
    [{ keywords: ["海", "海"] }, /duplicate value/u],
    [{ eventAt: "来週" }, /ISO timestamp/u],
    [{ cover: 3 }, /invalid text/u],
    [{ category: ["bad id"] }, /invalid item id/u],
  ];
  for (const [values, pattern] of wrong) assert.throws(() => parseCollectionItemResult({ status: "ready", item: post("p9", "x", {}, values) }, definition, "p9"), pattern);
  assert.throws(() => parseCollectionItemResult({ status: "ready", item: { ...post("p9", "x"), version: "" } }, definition, "p9"), /invalid label/u);
  assert.deepEqual(parseCollectionItemResult({ status: "not_found" }, definition, "p9"), { status: "not_found" });
});

test("mutation and upload results keep their closed shapes", () => {
  const definition = posts(), item = seed().posts.get("p1");
  assert.equal(parseCollectionSaveResult({ status: "saved", item }, definition, "p1").status, "saved");
  assert.equal(parseCollectionSaveResult({ status: "conflict", item }, definition, "p1").item.version, "v1");
  assert.deepEqual(parseCollectionSaveResult({ status: "invalid", errors: [{ field: "slug", message: "使われています。" }] }, definition, "p1"), { status: "invalid", errors: [{ field: "slug", message: "使われています。" }] });
  assert.throws(() => parseCollectionSaveResult({ status: "published", item }, definition, "p1"), /invalid status/u);
  assert.throws(() => parseCollectionSaveResult({ status: "saved", item: seed().posts.get("p2") }, definition, "p1"), /identity mismatch/u);
  assert.equal(parseCollectionPublishResult({ status: "publishing", item }, definition, "p1").status, "publishing");
  assert.equal(parseCollectionPublishResult({ status: "published", item }, definition, "p1").status, "published");
  assert.deepEqual(parseCollectionRemoveResult({ status: "removed" }, definition, "p1"), { status: "removed" });
  assert.throws(() => parseCollectionRemoveResult({ status: "removed", item }, definition, "p1"), /unknown field/u);
  assert.equal(parseCollectionCreateResult({ status: "created", item }, definition).item.id, "p1");
  assert.deepEqual(parseCollectionUploadResult({ status: "uploaded", url: "https://media.example.test/a.jpg", width: 10 }), { status: "uploaded", url: "https://media.example.test/a.jpg", width: 10 });
  assert.equal(parseCollectionUploadResult({ status: "uploaded", url: "/media/a.png" }).url, "/media/a.png");
  for (const url of ["javascript:alert(1)", "data:image/png;base64,AAAA", "http://media.example.test/a.jpg", "//evil.example.test/a.jpg", "https://user:pw@example.test/a.jpg"]) {
    assert.throws(() => parseCollectionUploadResult({ status: "uploaded", url }), /https URL/u);
  }
  assert.deepEqual(parseCollectionUploadResult({ status: "rejected", reason: "size" }), { status: "rejected", reason: "size" });
  assert.throws(() => parseCollectionUploadResult({ status: "rejected", reason: "virus" }), /invalid reason/u);
});

test("English publication DTO keeps only labelled safe states and supports an explicit retry conflict", () => {
  const ready = parseCollectionEnglishPublicationsReadResult({ status: "ready", englishPublications: [
    { key: "company", label: "会社ページ", publication: { state: "published", retryable: false, updatedAt: "2026-10-27T00:00:00Z" } },
    { key: "creator", label: "クリエイターページ", publication: { state: "retryable-failure", retryable: true } },
  ] });
  assert.deepEqual(ready.englishPublications.map(({ key, label }) => [key, label]), [["company", "会社ページ"], ["creator", "クリエイターページ"]]);
  assert.equal(ready.englishPublications[0].publication.updatedAt, "2026-10-27T00:00:00.000Z");
  assert.deepEqual(parseCollectionEnglishPublicationsRetryResult({ status: "conflict" }), { status: "conflict" });
  for (const invalid of [
    { status: "ready", englishPublications: [] },
    { status: "ready", englishPublications: [{ key: "company", label: "会社ページ", publication: { state: "unknown", retryable: false } }] },
    { status: "ready", englishPublications: [{ key: "company", label: "会社ページ", publication: { state: "published", retryable: false }, rawId: "internal" }] },
    { status: "ready", englishPublications: [
      { key: "company", label: "会社ページ", publication: { state: "published", retryable: false } },
      { key: "company", label: "重複", publication: { state: "published", retryable: false } },
    ] },
  ]) assert.throws(() => parseCollectionEnglishPublicationsReadResult(invalid));
});

test("validation checks required, length, slug, url, datetime and options before publishing", () => {
  const definition = posts();
  const values = parseCollectionItemResult({ status: "ready", item: seed().posts.get("p1") }, definition, "p1").item.values;
  assert.deepEqual(validateCollectionValues(definition, values), []);
  const check = (patch) => validateCollectionValues(definition, { ...values, ...patch }).map((error) => error.field);
  assert.deepEqual(check({ title: "   ", slug: "" }), ["title", "slug"]);
  assert.deepEqual(check({ title: "あ".repeat(41) }), ["title"]);
  assert.deepEqual(check({ title: "😀".repeat(40) }), [], "length counts code points");
  for (const slug of ["日本語", "with space", "a/b", "a.b"]) assert.deepEqual(check({ slug }), ["slug"], slug);
  assert.deepEqual(check({ slug: "Ok_slug-1" }), []);
  for (const source of ["javascript:alert(1)", "ftp://example.test", "/relative", "example.test", "https://user:pw@example.test"]) assert.deepEqual(check({ source }), ["source"], source);
  assert.deepEqual(check({ source: "http://example.test/a" }), []);
  assert.deepEqual(check({ eventAt: "2026-10-20 09:00" }), ["eventAt"]);
  assert.deepEqual(check({ kind: ["gone"] }), ["kind"]);
  assert.deepEqual(check({ summary: "説".repeat(121) }), ["summary"]);
  const required = { ...definition, fields: definition.fields.map((field) => ({ ...field, required: true })) };
  const missing = validateCollectionValues(required, { ...values, cover: null, body: "<p><br></p>", category: [], keywords: [], eventAt: null, source: " " }).map((error) => error.field);
  assert.deepEqual(missing, ["cover", "body", "category", "related", "keywords", "days", "eventAt", "source", "summary"]);
  assert.deepEqual(validateCollectionValues(required, { ...values, body: '<p><img src="https://a.example.test/x.jpg" alt=""></p>' }).map((error) => error.field).includes("body"), false);
});

test("list ordering, filters and the datetime-local conversion in a fixed time zone", () => {
  const items = [...seed().posts.values()].map(toSummary);
  assert.deepEqual(sortCollectionItems(items, "publishedAt").map((item) => item.id), ["p2", "p4", "p5", "p3", "p1"]);
  const circles = [...seed().circles.values()].map(toSummary);
  assert.deepEqual(sortCollectionItems(circles, "manual").map((item) => item.id), ["c3", "c2", "c1"]);
  assert.deepEqual(items.map((item) => collectionItemFilter(item.status)), ["published", "draft", "published", "draft", "published"]);
  assert.equal(collectionDateInputValue("2026-10-30T00:00:00Z", "Asia/Tokyo"), "2026-10-30T09:00");
  assert.equal(collectionDateFromInput("2026-11-03T10:30", "Asia/Tokyo"), "2026-11-03T01:30:00.000Z");
  assert.equal(collectionDateFromInput("2026-03-08T12:00", "America/New_York"), "2026-03-08T16:00:00.000Z");
  assert.equal(collectionDateFromInput("not a date", "Asia/Tokyo"), null);
  assert.equal(collectionDateInputValue(null, "Asia/Tokyo"), "");
  assert.ok(circlesDefinition());
});

test("rich text sanitizer keeps the allowed elements and attributes only", () => {
  const clean = (html, options) => sanitizeRichTextHtml(html, options);
  assert.equal(clean('<p onclick="steal()" style="color:red" class="x" id="y">文 <b>太</b> <i>斜</i></p>'), "<p>文 <strong>太</strong> <em>斜</em></p>");
  assert.equal(clean("<p>a</p><script>alert(1)</script><style>p{}</style><iframe src=\"https://example.test\"></iframe><noscript><p>n</p></noscript><template><p>t</p></template>"), "<p>a</p>");
  assert.equal(clean("<svg><script>alert(1)</script><text>s</text></svg><math><mi>x</mi></math><form><input value=\"x\"><button>押す</button><textarea>t</textarea></form>"), "");
  assert.equal(clean("<section><span>x</span><font color=red>y</font><custom-el>z</custom-el><u>u</u></section>"), "xyzu");
  assert.equal(clean("<h1 id=\"a\">見出し</h1><h5>小</h5><div>行</div><div><p>段落</p></div>"), "<h2>見出し</h2><h4>小</h4><p>行</p><p>段落</p>");
  assert.equal(clean("<ul><li>一</li></ul><ol><li>二</li></ol><blockquote>引用</blockquote><hr class=\"x\"><p>行<br data-x=\"1\">次</p><figure><img src=\"https://media.example.test/a.jpg\" alt=\"説明\" width=\"640\" height=\"480\" onerror=\"x()\" loading=\"lazy\"><figcaption>図</figcaption></figure>"),
    "<ul><li>一</li></ul><ol><li>二</li></ol><blockquote>引用</blockquote><hr><p>行<br>次</p><figure><img src=\"https://media.example.test/a.jpg\" alt=\"説明\" width=\"640\" height=\"480\"><figcaption>図</figcaption></figure>");
  // リンク: http・https・mailto だけ。それ以外は a を外して中身を残す
  assert.equal(clean('<a href="https://example.test/a?b=1" target="_blank" rel="opener" onclick="x()">外</a>'), '<a href="https://example.test/a?b=1">外</a>');
  assert.equal(clean('<a href="http://example.test/">h</a><a href="mailto:info@example.test">m</a>'), '<a href="http://example.test/">h</a><a href="mailto:info@example.test">m</a>');
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\nscript:alert(1)", "data:text/html,x", "vbscript:x", "/posts/x", "#top", "https://user:pw@example.test/", "tel:0000"]) {
    assert.equal(clean(`<a href="${href}">中身</a>`), "中身", href);
  }
  // 画像: https だけ。ほかは img を消す。"/" から始まる path はホストが許したときだけ
  for (const src of ["http://media.example.test/a.jpg", "data:image/png;base64,AAAA", "javascript:alert(1)", "//evil.example.test/a.jpg", "/media/a.jpg", ""]) {
    assert.equal(clean(`<p>前<img src="${src}" alt="x">後</p>`), "<p>前後</p>", src);
  }
  assert.equal(clean('<p><img src="/media/a.jpg" alt=""></p>', { isImageSrcAllowed: (src) => src.startsWith("/media/") }), '<p><img src="/media/a.jpg" alt=""></p>');
  assert.equal(clean('<p><img src="/other/a.jpg"></p>', { isImageSrcAllowed: (src) => src.startsWith("/media/") }), "<p></p>");
  assert.equal(clean('<img src="https://media.example.test/a.jpg" width="100px" height="50">'), '<img src="https://media.example.test/a.jpg" alt="" height="50">');
  assert.equal(clean("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; <!-- c --></p>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; </p>");
  assert.equal(clean(""), "");
});

const galleryDefinition = () => ({
  id: "companies", label: "会社", addLabel: "追加する", ordering: "manual", pathPrefix: "/companies/",
  titleField: "name", slugField: null, imageField: null, subtitleField: null,
  capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: false, redirects: true, reorder: true, bulk: true, retrySchedule: false },
  fields: [
    { key: "name", label: "名前", type: "text", required: true, placement: "main" },
    { key: "portfolio", label: "作品／活動", type: "gallery", captionLabel: "説明", placement: "main", maxItems: 3, captionMaxLength: 10 },
  ],
});

test("capabilities accept the old five keys and the optional new keys, defaulting the new ones to false", () => {
  const old = parseCollectionSchemaResult(schema()).collections[0].capabilities;
  assert.deepEqual(old, { create: true, duplicate: true, remove: true, unpublish: true, schedule: true, redirects: false, reorder: false, bulk: false, retrySchedule: false });
  const next = parseCollectionSchemaResult({ status: "ready", collections: [galleryDefinition()] }).collections[0].capabilities;
  assert.deepEqual(next, galleryDefinition().capabilities);
  const partial = withPosts((definition) => { definition.capabilities.bulk = true; });
  assert.equal(parseCollectionSchemaResult(partial).collections[0].capabilities.bulk, true);
  assert.equal(parseCollectionSchemaResult(partial).collections[0].capabilities.reorder, false);
  assert.throws(() => parseCollectionSchemaResult(withPosts((definition) => { definition.capabilities.reorder = "yes"; })), /expected a boolean/u);
  assert.throws(() => parseCollectionSchemaResult(withPosts((definition) => { definition.capabilities.archive = true; })), /unknown field/u);
});

test("gallery fields and values parse strictly and validate count, caption length and images", () => {
  const definition = parseCollectionSchemaResult({ status: "ready", collections: [galleryDefinition()] }).collections[0];
  assert.deepEqual(definition.fields[1], galleryDefinition().fields[1]);
  const bad = [
    [(field) => { delete field.captionLabel; }, /invalid label/u],
    [(field) => { field.maxItems = 0; }, /positive integer/u],
    [(field) => { field.maxItems = 501; }, /positive integer/u],
    [(field) => { field.multiple = true; }, /unknown field/u],
  ];
  for (const [mutate, pattern] of bad) {
    const input = galleryDefinition(); mutate(input.fields[1]);
    assert.throws(() => parseCollectionSchemaResult({ status: "ready", collections: [input] }), pattern);
  }
  const entries = [{ id: "w1", image: "https://media.example.test/a.jpg", caption: "一つ目\n二行目" }, { id: "", image: null, caption: "" }];
  assert.deepEqual(parseCollectionValues({ name: "架空の会社", portfolio: entries }, definition).portfolio, entries);
  assert.deepEqual(parseCollectionValues({ name: "x" }, definition).portfolio, []);
  assert.deepEqual(parseCollectionValues({ portfolio: [{ id: "", image: "", caption: "" }] }, definition).portfolio, [{ id: "", image: null, caption: "" }]);
  for (const [value, pattern] of [
    [[{ id: "w1", image: null }], /needs id, image and caption/u],
    [[{ id: "w1", image: null, caption: "", order: 1 }], /unknown field/u],
    [[{ id: "../w", image: null, caption: "" }], /invalid gallery entry id/u],
    [[{ id: "..", image: null, caption: "" }], /invalid gallery entry id/u],
    [[{ id: 1, image: null, caption: "" }], /invalid gallery entry id/u],
    [[{ id: "w1", image: 3, caption: "" }], /invalid text/u],
    [[{ id: "w1", image: null, caption: 1 }], /invalid string/u],
    [[{ id: "w1", image: null, caption: "" }, { id: "w1", image: null, caption: "" }], /duplicate gallery entry/u],
    [["w1"], /expected a JSON object/u],
    ["w1", /expected an array/u],
  ]) assert.throws(() => parseCollectionValues({ portfolio: value }, definition), pattern);
  const check = (portfolio) => validateCollectionValues(definition, { name: "x", portfolio }).map((error) => error.message);
  assert.deepEqual(check(entries), []);
  assert.deepEqual(check([...entries, ...entries.map((entry) => ({ ...entry, id: "" }))]), ["3 件までにしてください（いま 4 件）。"]);
  assert.deepEqual(check([{ id: "", image: "javascript:alert(1)", caption: "" }]), ["1 件目の画像を選び直してください。"]);
  assert.deepEqual(check([{ id: "", image: null, caption: "" }, { id: "", image: null, caption: "あ".repeat(11) }]), ["2 件目の説明を 10 文字以内にしてください（いま 11 文字）。"]);
  const required = { ...definition, fields: definition.fields.map((field) => ({ ...field, required: true })) };
  assert.deepEqual(validateCollectionValues(required, { name: "x", portfolio: [] }), [{ field: "portfolio", message: "1 件以上追加してください。" }]);
});

test("reorder and bulk results carry the list; remove may be invalid; the reorder sequence keeps the host order on ties", () => {
  const items = [...seed().circles.values()].map(toSummary);
  for (const parse of [parseCollectionReorderResult, parseCollectionBulkResult]) {
    for (const status of ["publishing", "saved", "conflict"]) assert.deepEqual(parse({ status, items }), { status, items });
    assert.deepEqual(parse({ status: "invalid", errors: [{ field: "", message: "公開できない項目があります。" }] }), { status: "invalid", errors: [{ field: "", message: "公開できない項目があります。" }] });
    assert.deepEqual(parse({ status: "forbidden" }), { status: "forbidden" });
    assert.throws(() => parse({ status: "publishing", items: [items[0], items[0]] }), /duplicate item/u);
    assert.throws(() => parse({ status: "publishing", items, extra: 1 }), /unknown field/u);
    assert.throws(() => parse({ status: "removed", items }), /invalid status/u);
  }
  assert.deepEqual(parseCollectionRemoveResult({ status: "invalid", errors: [{ field: "", message: "移動先を選び直してください" }] }, posts(), "p1"), { status: "invalid", errors: [{ field: "", message: "移動先を選び直してください" }] });
  const tied = [{ ...items[0], id: "b", order: 2 }, { ...items[0], id: "draft", order: null }, { ...items[0], id: "a", order: 1 }, { ...items[0], id: "c", order: 2 }];
  assert.deepEqual(collectionReorderSequence(tied).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(moveCollectionIds(["a", "b", "c", "d"], 1, 3), ["a", "c", "d", "b"]);
  assert.deepEqual(moveCollectionIds(["a", "b", "c", "d"], 3, 0), ["d", "a", "b", "c"]);
});

test("editor status: an edit on a published item is 変更あり, and the publish request in flight shows 反映中 (kamakura-site#155)", async () => {
  const { editorStatus } = await import("../dist/collection-workspace.js");
  assert.equal(editorStatus("published", false, null), "published");
  assert.equal(editorStatus("published", true, null), "changed");
  assert.equal(editorStatus("changed", false, "publish"), "publishing", "the saved draft's 変更あり is not shown while publishing");
  assert.equal(editorStatus("draft", false, "publish"), "publishing");
  assert.equal(editorStatus("changed", false, "save"), "changed");
  assert.equal(editorStatus("publishing", false, null), "publishing");
});
