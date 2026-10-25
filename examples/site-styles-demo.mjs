// サイト共通スタイルの最小例（React 不要）。`npm run demo:site-styles` で実行する。
// 2 ページが同じサイト共通カラーを参照し、1 回の変更で両方の CSS が変わること、ページ固有の上書きが残ること、
// 旧文書の出力が変わらないこと、サイトの定義を消すときの切り離しを標準出力で確かめる。保存先・認証・実サイトには接続しない。
import { readFileSync } from "node:fs";
import { detachRemovedSiteStyles, generatePageCss, parsePageDocument, resolvePageStyles } from "@niho/web/core";
import { parseSiteSettings } from "@niho/web/pages";
import { renderPageToHtml } from "@niho/web/server";

const read = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
const variables = (css) => Object.fromEntries([...css.split("\n")[0].matchAll(/--nw-([A-Za-z0-9-]+):([^;]+);/g)].map(([, name, value]) => [name, value]));
const markup = (html) => html.replace(/<style[^]*?<\/style>/, "");
const styleBlock = (html) => html.match(/<style data-nw-style="[^"]+">([^]*?)<\/style>/)?.[1] ?? "";

/** 例を実行し、確認した結果を返す。log を差し替えると出力を抑えられる。 */
export function runSiteStylesDemo({ log = console.log } = {}) {
  // サイト共通: brand（メイン）・ink（文字の色の既定）・headingSize と、見出しの文字スタイル。
  const settings = parseSiteSettings(read("site-settings.json"));
  // 旧文書: 自分の ink を持ち、サイト共通を参照しない。
  const legacy = read("page.json");
  // ホーム: 旧文書に、サイト共通の見出しスタイルとメインの色を使う見出しを足した例。
  const home = structuredClone(legacy);
  home.body[0].children[0].style = { textStyle: "heading", base: { color: { token: "brand" } } };
  // 「私たちについて」: サイト共通の brand / ink / heading と、このページだけの accent を使う。
  const about = read("site-styled-page.json");

  const render = (document, siteStyles) => {
    const html = renderPageToHtml(document, {}, siteStyles ? { siteStyles } : {}), css = generatePageCss(document, {}, undefined, siteStyles);
    if (styleBlock(html) !== css) throw new Error("SSR の <style> と generatePageCss が一致しません");
    return { html, css, variables: variables(css) };
  };

  log("# 1. 検証: ページ JSON にはページ所有の定義だけが残る");
  const aboutPage = parsePageDocument(about, {}, { siteStyles: settings });
  log(`  about.tokens = ${JSON.stringify(Object.keys(aboutPage.tokens))}（brand / ink / headingSize はサイト共通から継承）`);
  let rejected = false;
  try { parsePageDocument(about); } catch { rejected = true; }
  log(`  設定なしで検証 → ${rejected ? "拒否（unknown token）" : "受理"}`);

  log("# 2. 描画: 2 ページが同じサイト共通カラーを参照し、ページの ink はページの値が勝つ");
  const before = { home: render(home, settings), about: render(about, settings), legacy: render(legacy, settings) };
  for (const [name, result] of Object.entries(before)) log(`  ${name}: --nw-brand=${result.variables.brand} --nw-ink=${result.variables.ink}`);

  log("# 3. 変更: brand を 1 回変えると、参照する両ページの CSS が変わる。HTML の構造は変わらない");
  const changed = { ...settings, tokens: { ...settings.tokens, brand: { ...settings.tokens.brand, value: "#0055aa" } } };
  const after = { home: render(home, changed), about: render(about, changed), legacy: render(legacy, changed) };
  const sharedChanged = after.home.variables.brand === "#0055aa" && after.about.variables.brand === "#0055aa" && after.home.css !== before.home.css && after.about.css !== before.about.css;
  const markupStable = Object.keys(before).every((name) => markup(before[name].html) === markup(after[name].html));
  log(`  home/about の --nw-brand → ${after.home.variables.brand} / ${after.about.variables.brand}、HTML の構造は${markupStable ? "同じ" : "変わった"}`);
  const overrideKept = before.legacy.variables.ink === "#172d25" && after.legacy.variables.ink === "#172d25" && after.about.variables.accent === "#f2b705";
  log(`  ページ固有の値（page.json の ink、about の accent）は${overrideKept ? "そのまま" : "変わった"}`);

  log("# 4. 互換: 設定なし・空の設定で旧文書の出力は同じ");
  const plain = renderPageToHtml(legacy), empty = renderPageToHtml(legacy, {}, { siteStyles: {} });
  const legacyUnchanged = plain === empty && generatePageCss(legacy) === generatePageCss(legacy, {}, undefined, {});
  log(`  renderPageToHtml(page.json) と siteStyles: {} → ${legacyUnchanged ? "一致" : "不一致"}`);

  log("# 5. 削除: サイトから brand と見出しスタイルを消すと、参照は今の見た目のままページ所有の値に切り離される");
  const { brand: _brand, ...tokens } = settings.tokens;
  const removed = { tokens };
  const detached = detachRemovedSiteStyles(aboutPage, settings, removed);
  parsePageDocument(detached, {}, { siteStyles: removed });
  const heading = detached.body[0].children[0];
  const detachedColor = heading.style.base.color, detachedStyle = detached.textStyles?.heading;
  log(`  about の見出しの色 → ${JSON.stringify(detachedColor)}、見出しスタイルは${detachedStyle ? "ページの textStyles に写した" : "写していない"}`);
  const resolvedBefore = resolvePageStyles(aboutPage, settings), resolvedAfter = resolvePageStyles(detached, removed);
  const sameLook = generatePageCss(resolvedBefore).split("\n").slice(1).join("\n") === generatePageCss(resolvedAfter).split("\n").slice(1).join("\n").replace(/color:#195640;/g, "color:var(--nw-brand);");
  log(`  切り離し前後でノードの CSS 規則は${sameLook ? "同じ見た目" : "異なる"}`);

  return { sharedChanged, markupStable, overrideKept, legacyUnchanged, detachedColor, detachedStyle, before, after };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = runSiteStylesDemo();
  const ok = result.sharedChanged && result.markupStable && result.overrideKept && result.legacyUnchanged && result.detachedColor === "#195640" && !!result.detachedStyle;
  console.log(ok ? "すべて確認できました。" : "確認できない項目があります。");
  process.exitCode = ok ? 0 : 1;
}
