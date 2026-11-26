import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, detachRemovedSiteStyles, generatePageCss, mergeSiteStyles, parsePageDocument, parseSiteStyles, resolvePageDocument, resolvePageStyles } from "@niho/web/core";
import { parseSiteSettings } from "../dist/pages.js";
import { renderPageToHtml } from "@niho/web/server";
import { collectLocalizationUnits, createLocalizationOverlay, materializeLocalizedPage, validateLocalizedDocumentSave } from "@niho/web/localization";
import { createPublishedSiteLocaleSnapshot, parsePublishedSiteLocaleSnapshot, verifyPublishedSiteLocaleSnapshot } from "@niho/web/localization-release";
import { resolvePageStylesForEditor, retainPageStyles } from "../dist/site-styles.js";
import { EditorSessionLoadError, readEditorSession } from "../dist/editor-session.js";
import { runSiteStylesDemo } from "../examples/site-styles-demo.mjs";

// docs/site-styles-contract.md の検証。examples/ の最小例を入力にする。
const read = (name) => JSON.parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), "utf8"));
const legacy = read("page.json"), about = read("site-styled-page.json"), settingsJson = read("site-settings.json");
const settings = () => parseSiteSettings(structuredClone(settingsJson));
const styleOf = (html) => html.match(/<style data-nw-style="[^"]+">([^]*?)<\/style>/)[1];
const markup = (html) => html.replace(/<style[^]*?<\/style>/, "");
const rules = (css) => css.split("\n").slice(1);
const invalid = (fn) => assert.throws(fn, DocumentValidationError);
const rejects = (promise) => assert.rejects(promise, DocumentValidationError);
const color = (value, label) => ({ type: "color", value, ...(label ? { label } : {}) });

test("site styles are validated on their own and page definitions win over the same names", () => {
  const site = settings();
  assert.deepEqual(Object.keys(parseSiteStyles(site)), ["tokens", "textStyles"]);
  // サイトの文字スタイルはサイトの token だけで検証する。ページの token で補えない。
  invalid(() => parseSiteStyles({ textStyles: { h: { base: { fontSize: { token: "nope" } } } } }));
  invalid(() => parsePageDocument({ ...about, tokens: { ...about.tokens, nope: { type: "length", value: 10 } } }, {}, { siteStyles: { textStyles: { h: { base: { fontSize: { token: "nope" } } } } } }));
  const merged = mergeSiteStyles({ tokens: { ink: color("#172d25") } }, site);
  assert.deepEqual(merged.tokens.ink, color("#172d25"), "the page definition replaces the site definition");
  assert.deepEqual(merged.tokens.brand, site.tokens.brand); assert.deepEqual(merged.textStyles, site.textStyles);
  // ページの override で型が変わり、継承した文字スタイルが不適合になれば拒否する。
  invalid(() => mergeSiteStyles({ tokens: { headingSize: color("#ffffff") } }, site));
  assert.deepEqual(mergeSiteStyles({ tokens: {} }, {}), { tokens: {} });
});

test("pages keep only their own definitions and SSR, CSS and the resolved document agree", () => {
  const site = settings(), page = parsePageDocument(about, {}, { siteStyles: site });
  assert.deepEqual(page.tokens, about.tokens, "inherited tokens are not written into the page");
  assert.equal(page.textStyles, undefined);
  invalid(() => parsePageDocument(about), "a shared reference needs the settings");
  invalid(() => generatePageCss(about));
  const html = renderPageToHtml(about, {}, { siteStyles: site }), css = generatePageCss(about, {}, undefined, site);
  assert.equal(styleOf(html), css);
  assert.match(css, /--nw-accent:#f2b705;--nw-brand:#195640;--nw-headingSize:2rem;--nw-ink:#111111;/);
  assert.match(css, /\[data-nw-node="about_heading"\]\{font-size:24px;font-weight:700;line-height:1\.3;\}/);
  assert.match(css, /@media \(min-width:768px\)\{[^}]*about_heading"\]\{font-size:var\(--nw-headingSize\);\}\}/);
  assert.match(css, /about_heading"\]\{color:var\(--nw-brand\);\}/);
  assert.ok(css.indexOf("font-weight:700") < css.indexOf("color:var(--nw-brand)"), "text style rules come before node rules");
  // 実効値を含む展開済み文書は設定なしで同じ出力になる。
  const effective = resolvePageStyles(page, site);
  assert.deepEqual(Object.keys(effective.tokens).sort(), ["accent", "brand", "headingSize", "ink"]);
  assert.equal(renderPageToHtml(effective), html);
  assert.deepEqual(resolvePageDocument(about, undefined, {}, site).document, effective);
});

test("one site-wide change reaches every page that references it while page-specific values stay", () => {
  const site = settings(), home = structuredClone(legacy);
  home.body[0].children[0].style = { textStyle: "heading", base: { color: { token: "brand" } } };
  const before = { home: generatePageCss(home, {}, undefined, site), about: generatePageCss(about, {}, undefined, site) };
  for (const css of Object.values(before)) assert.match(css, /--nw-brand:#195640;/);
  const changed = { ...site, tokens: { ...site.tokens, brand: color("#0055aa", "メイン") } };
  const after = { home: generatePageCss(home, {}, undefined, changed), about: generatePageCss(about, {}, undefined, changed) };
  for (const css of Object.values(after)) assert.match(css, /--nw-brand:#0055aa;/);
  assert.deepEqual(rules(after.home), rules(before.home)); assert.deepEqual(rules(after.about), rules(before.about));
  assert.equal(markup(renderPageToHtml(home, {}, { siteStyles: changed })), markup(renderPageToHtml(home, {}, { siteStyles: site })));
  // page.json の ink はサイトの ink より優先され、about の accent はページだけの値のまま。
  assert.match(after.home, /--nw-ink:#172d25;/); assert.match(after.about, /--nw-ink:#111111;/); assert.match(after.about, /--nw-accent:#f2b705;/);
  assert.deepEqual(parsePageDocument(legacy, {}, { siteStyles: changed }).tokens, legacy.tokens);
});

test("old documents render the same without settings, with empty settings and apart from added variables", () => {
  assert.equal(renderPageToHtml(legacy), renderPageToHtml(legacy, {}, { siteStyles: {} }));
  assert.equal(generatePageCss(legacy), generatePageCss(legacy, {}, undefined, {}));
  assert.deepEqual(parsePageDocument(legacy, {}, { siteStyles: settings() }), parsePageDocument(legacy));
  const withSite = renderPageToHtml(legacy, {}, { siteStyles: settings() });
  assert.equal(markup(withSite), markup(renderPageToHtml(legacy)));
  assert.deepEqual(rules(styleOf(withSite)), rules(generatePageCss(legacy)), "node rules are unchanged; only site variables are added");
  assert.match(styleOf(withSite), /--nw-brand:#195640;--nw-headingSize:2rem;--nw-ink:#172d25;/);
});

test("retainPageStyles drops unchanged inherited values and keeps explicit overrides", () => {
  const site = settings(), original = parsePageDocument(about, {}, { siteStyles: site }), effective = resolvePageStyles(original, site);
  assert.deepEqual(retainPageStyles(effective, original, site), original);
  const recolored = { ...effective, tokens: { ...effective.tokens, brand: color("#0055aa", "メイン") } };
  assert.deepEqual(retainPageStyles(recolored, original, site).tokens, { ...about.tokens, brand: color("#0055aa", "メイン") }, "a changed inherited value becomes a page override");
  const explicit = parsePageDocument({ ...about, tokens: { ...about.tokens, ink: site.tokens.ink } }, {}, { siteStyles: site });
  assert.deepEqual(retainPageStyles(resolvePageStyles(explicit, site), explicit, site).tokens, explicit.tokens, "an override equal to the site value is kept");
});

test("editor style resolution reuses equivalent maps and refreshes changed style values", () => {
  const site = settings(), page = parsePageDocument(about, {}, { siteStyles: site });
  const first = resolvePageStylesForEditor(page, site);
  const equivalent = { ...page, tokens: { ...page.tokens }, ...(page.textStyles ? { textStyles: structuredClone(page.textStyles) } : {}) };
  const second = resolvePageStylesForEditor(equivalent, site);
  assert.strictEqual(second.tokens, first.tokens);
  assert.strictEqual(second.textStyles, first.textStyles);

  const changed = { ...site, tokens: { ...site.tokens, ink: color("#123456", "変更色") } };
  const updated = resolvePageStylesForEditor(equivalent, changed);
  assert.notStrictEqual(updated.tokens, first.tokens);
  assert.equal(updated.tokens.ink.value, "#123456");
});

test("retainPageStyles returns the same document when no inherited values need removal", () => {
  const site = settings();
  const page = parsePageDocument({ ...about, tokens: { ...about.tokens, local: color("#222222", "ページ色") }, textStyles: { local: { base: { fontSize: 16 } } } }, {}, { siteStyles: site });
  assert.strictEqual(retainPageStyles(page, page, site), page);
});

test("removing site definitions detaches references into page-owned values that keep the appearance", () => {
  const site = settings(), page = parsePageDocument(about, {}, { siteStyles: site });
  const { brand: _brand, ...tokens } = site.tokens;
  const next = { tokens }; // brand と見出しスタイルを消す
  const detached = detachRemovedSiteStyles(page, site, next);
  assert.equal(detached.body[0].children[0].style.base.color, "#195640", "the removed token becomes its literal value");
  assert.deepEqual(detached.textStyles, { heading: site.textStyles.heading }, "the removed text style is copied with its responsive rules");
  assert.deepEqual(detached.tokens, about.tokens);
  parsePageDocument(detached, {}, { siteStyles: next });
  const before = rules(generatePageCss(resolvePageStyles(page, site))), after = rules(generatePageCss(resolvePageStyles(detached, next)));
  assert.deepEqual(after, before.map((rule) => rule.replace("color:var(--nw-brand);", "color:#195640;")));
  // 残る文字スタイルが参照する token も消すと、文字スタイル側の参照も literal になる。
  const bare = detachRemovedSiteStyles(page, site, { tokens: { ink: site.tokens.ink } });
  assert.equal(bare.textStyles.heading.responsive[0].declarations.fontSize, "2rem");
  parsePageDocument(bare, {}, { siteStyles: { tokens: { ink: site.tokens.ink } } });
  // サイト token と同名のページ上書きがあっても、削除時は旧共有文字スタイルをページ所有へ切り離す。
  const overridden = parsePageDocument({ ...about, tokens: { ...about.tokens, headingSize: { ...site.tokens.headingSize, value: "4rem" } } }, {}, { siteStyles: site });
  const nextWithLiteralStyle = { tokens: Object.fromEntries(Object.entries(site.tokens).filter(([name]) => name !== "headingSize")),
    textStyles: { ...site.textStyles, heading: { ...site.textStyles.heading, responsive: [{ minWidth: 768, declarations: { fontSize: "2rem" } }] } } };
  const detachedOverride = detachRemovedSiteStyles(overridden, site, nextWithLiteralStyle);
  const resolvedOverride = resolvePageStyles(detachedOverride, nextWithLiteralStyle);
  assert.deepEqual(detachedOverride.textStyles?.heading, site.textStyles.heading, "the old shared style becomes a page override when its token is removed");
  assert.equal(resolvedOverride.tokens.headingSize.value, "4rem");
  assert.equal(generatePageCss(resolvePageStyles(overridden, site)), generatePageCss(resolvedOverride), "the page token override keeps its rendered size");
  // ページが同名の定義を持つ参照は触らない。
  const owned = parsePageDocument({ ...about, tokens: { ...about.tokens, brand: color("#000000") } }, {}, { siteStyles: site });
  assert.deepEqual(detachRemovedSiteStyles(owned, site, next).body[0].children[0].style.base.color, { token: "brand" });
  assert.strictEqual(detachRemovedSiteStyles(page, site, site), page, "no removal preserves the immutable page snapshot");
});

test("parseSiteSettings validates styles with the public information and rejects invalid shapes", () => {
  const parsed = parseSiteSettings(settingsJson);
  assert.deepEqual(parsed.tokens, settingsJson.tokens); assert.deepEqual(parsed.textStyles, settingsJson.textStyles);
  assert.deepEqual(parseSiteSettings({ title: "a", locale: "ja" }), { title: "a", locale: "ja" }, "styles stay optional");
  invalid(() => parseSiteSettings({ ...settingsJson, textStyles: { h: { base: { fontSize: { token: "nope" } } } } }));
  invalid(() => parseSiteSettings({ ...settingsJson, styles: {} }));
  invalid(() => parseSiteSettings({ ...settingsJson, tokens: { Brand: color("#000000") } }));
  invalid(() => parseSiteSettings({ ...settingsJson, tokens: { brand: { type: "color", value: "red; }" } } }));
  invalid(() => parseSiteSettings({ ...settingsJson, tokens: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`c${index}`, color("#000000")])) }));
});

test("a host without site settings keeps self-contained documents working and stops shared references", async () => {
  const target = { siteId: "demo", pageId: "home", locale: "ja-JP" }, signal = new AbortController().signal;
  const plain = await readEditorSession({ readDocument: async () => ({ document: legacy, version: "v1" }) }, target, signal);
  assert.equal(plain.session.selfContained, true); assert.equal(plain.session.siteStyles, undefined); assert.equal(plain.warning, undefined);
  await assert.rejects(() => readEditorSession({ readDocument: async () => ({ document: about, version: "v1" }) }, { ...target, pageId: "about" }, signal),
    (error) => error instanceof EditorSessionLoadError && error.reason === "document");
  const supported = await readEditorSession({ readDocument: async () => ({ document: about, version: "v1" }), readSiteSettings: async () => ({ settings: settingsJson, version: "s1" }) }, { ...target, pageId: "about" }, signal);
  assert.deepEqual(supported.session.siteStyles.tokens, settingsJson.tokens); assert.equal(supported.session.selfContained, false);
  assert.deepEqual(supported.session.history.present.tokens, about.tokens, "the working copy holds page-owned definitions only");
});

const localizationConfig = { schemaVersion: 1, siteId: "demo", sourceLocale: "ja", defaultLocale: "ja", enabledLocales: ["ja", "en"], documentLocales: { ja: "ja-JP", en: "en" }, glossaryVersion: "g1", contextVersion: "c1" };

test("localization validates and materializes pages that reference site styles with the same settings", async () => {
  const site = settings();
  await rejects(collectLocalizationUnits(localizationConfig, about, "en", {}));
  const draft = { siteStyles: site, siteStylesRevision: { stage: "draft", version: "styles-draft-1" } };
  const collection = await collectLocalizationUnits(localizationConfig, about, "en", draft);
  assert.deepEqual(collection.issues, []);
  assert.deepEqual(collection.units.map((unit) => unit.unitId).sort(), ["page.node.about_heading.text", "page.node.about_lead.text", "page.title"], "tokens and text styles are not translation units");
  const materialized = await materializeLocalizedPage(localizationConfig, about, collection, createLocalizationOverlay(collection), draft);
  assert.equal(materialized.document.locale, "en");
  assert.deepEqual(materialized.document.tokens, about.tokens, "the translated page keeps page-owned definitions only");
  assert.equal(materialized.document.textStyles, undefined);
  const saved = await validateLocalizedDocumentSave(localizationConfig, about, materialized.document, draft);
  assert.equal(saved.document.locale, "en");
  await rejects(validateLocalizedDocumentSave(localizationConfig, about, materialized.document, {}));
  assert.equal(generatePageCss(materialized.document, {}, undefined, site).includes("--nw-brand:#195640;"), true);
});

const sha = (letter) => `sha256-${letter.repeat(64)}`;
const releaseInput = (page) => ({ config: localizationConfig, locale: "ja", releaseId: "release-1", version: "v1", pages: [{ path: "/about", document: page }], publicPageIds: ["about"],
  components: { schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [] }, navigation: [],
  manifest: { source: { version: "source-1", digest: sha("a") }, config: { version: "config-1", digest: sha("b") }, resources: [] },
  completeness: { reviewedPageIds: [], sharedReviewed: false, unresolvedIssues: [] } });

test("a locale release fixes the effective site styles into self-contained pages", async () => {
  const site = settings();
  await rejects(createPublishedSiteLocaleSnapshot(releaseInput(about)));
  const snapshot = await createPublishedSiteLocaleSnapshot(releaseInput(about), { siteStyles: site, siteStylesRevision: { stage: "published", version: "styles-public-1" } });
  const published = snapshot.pages[0].document;
  assert.deepEqual(Object.keys(published.tokens).sort(), ["accent", "brand", "headingSize", "ink"]);
  assert.deepEqual(published.textStyles, site.textStyles);
  assert.equal(generatePageCss(published), generatePageCss(about, {}, undefined, site), "the stored page renders without the settings");
  parsePublishedSiteLocaleSnapshot(snapshot); await verifyPublishedSiteLocaleSnapshot(snapshot);
  const changed = await createPublishedSiteLocaleSnapshot(releaseInput(about), { siteStyles: { ...site, tokens: { ...site.tokens, brand: color("#0055aa", "メイン") } }, siteStylesRevision: { stage: "published", version: "styles-public-2" } });
  assert.notEqual(changed.contentDigest, snapshot.contentDigest, "a site-wide change shows up in the next release");
  assert.equal(changed.pages[0].document.tokens.brand.value, "#0055aa");
  const legacyRelease = await createPublishedSiteLocaleSnapshot(releaseInput({ ...legacy, pageId: "about" }));
  assert.deepEqual(legacyRelease.pages[0].document.tokens, legacy.tokens, "self-contained pages release without settings as before");
});

test("the example demo confirms every documented behaviour", () => {
  const result = runSiteStylesDemo({ log: () => {} });
  assert.equal(result.sharedChanged, true); assert.equal(result.markupStable, true); assert.equal(result.overrideKept, true); assert.equal(result.legacyUnchanged, true);
  assert.equal(result.detachedColor, "#195640"); assert.deepEqual(result.detachedStyle, settingsJson.textStyles.heading);
});
