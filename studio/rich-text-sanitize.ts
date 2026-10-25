/**
 * Studio の本文（richText）の無害化。共有の `sanitizeRichTextHtml`（src/collection-model.ts）と同じ作り
 * （DOMParser で読み、許可した要素・属性だけを組み直す）で、STUDIO から移した本文の書式を落とさないように許可を広げたもの。
 *
 * 共有の許可に足したもの:
 * - 見出し `h1`〜`h4` の `id`（目次の飛び先）。`h1` は `h2` に置き換えない（`h5`・`h6` は `h4`）。
 * - `figure` の `style`、`img` の空の `width=""`・`height=""`、`a` の `target`・`rel`、`/` と `#` から始まるリンク。
 * - `u`・`s`（`del`・`strike` は `s`）・`code`、`ol` の `start`・`type`。
 * - 目次の置き場（属性も中身も無い `<div></div>`）。
 * - 埋め込み `<div data-type="embed_code">`。中は埋め込み用の許可（`class`・`style`・`data-*`、https の `iframe` など）で組み直す。
 * - https の `iframe`、表（`table` など）。
 *
 * 落とすもの: `script`・`style`・フォームの部品などは中身ごと、`on*` 属性、`javascript:` などのリンク、
 * `url(` や `expression(` を含む `style`、コメント。知らない要素は外して中身を残す。
 * 埋め込みの `<script>`（Instagram の embed.js など）も残らない。公開するページの側で読み込むこと。
 */

export type StudioRichTextSanitizeOptions = {
  /** "/" から始まる同じサイトの画像を残してよいか。既定は https の画像だけ残す。 */
  readonly isImageSrcAllowed?: (src: string) => boolean;
};

const HTML_NS = "http://www.w3.org/1999/xhtml";
/** 中身ごと消す要素（共有の無害化と同じ。iframe は https だけ別に残す）。 */
const DROP = new Set([
  "script", "style", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed", "noframes", "template",
  "svg", "math", "link", "meta", "base", "title", "head", "form", "input", "button", "select", "option", "optgroup", "textarea",
  "canvas", "audio", "video", "source", "track", "param", "picture", "map", "area", "dialog", "portal", "slot", "datalist", "output",
]);
const RENAME: Readonly<Record<string, string>> = { b: "strong", i: "em", strike: "s", del: "s", h5: "h4", h6: "h4" };
/** 属性を持たない要素。 */
const PLAIN = new Set(["p", "strong", "em", "u", "s", "code", "ul", "li", "blockquote", "br", "hr", "figcaption", "thead", "tbody", "tfoot", "tr", "caption"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4"]);
const TABLE = new Set(["table", "th", "td", "colgroup", "col"]);
const BLOCK = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "figure", "hr", "div", "section", "article", "table", "pre", "header", "footer", "aside", "nav", "main", "iframe"]);
/** 埋め込みの中で残す要素（名前は変えない）。 */
const EMBED_KEEP = new Set([
  "div", "span", "p", "blockquote", "a", "img", "iframe", "br", "hr", "strong", "em", "b", "i", "u", "s", "small", "time",
  "figure", "figcaption", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer",
]);
const EMBED_COMMON = new Set(["class", "style", "title", "lang", "dir"]);
const REL = new Set(["noopener", "noreferrer", "nofollow", "ugc", "sponsored", "external", "me"]);
const TARGET = new Set(["_blank", "_self", "_parent", "_top"]);
const IFRAME_ALLOW = new Set(["accelerometer", "autoplay", "clipboard-write", "encrypted-media", "gyroscope", "picture-in-picture", "web-share", "fullscreen"]);
const SANDBOX = new Set(["allow-scripts", "allow-same-origin", "allow-popups", "allow-popups-to-escape-sandbox", "allow-presentation", "allow-forms"]);
const REFERRER = new Set(["no-referrer", "no-referrer-when-downgrade", "origin", "origin-when-cross-origin", "same-origin", "strict-origin", "strict-origin-when-cross-origin", "unsafe-url"]);
/** 見出しの id（STUDIO の目次は index_xxxxxxxx）。 */
export const HEADING_ID = /^[A-Za-z][\w:.-]{0,127}$/u;
const UNSAFE_CHARS = /[\s\u0000-\u001f\u007f<>"'\\]/u;

/** 本文のリンクに使ってよいか（http・https・mailto・"/" から始まる path・"#" から始まる飛び先）。 */
export function studioRichTextHref(value: string | null): string | null {
  if (value === null) return null;
  const href = value.trim();
  if (!href || href.length > 2048 || UNSAFE_CHARS.test(href)) return null;
  if (href.startsWith("#")) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return href;
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname && !url.username && !url.password) return href;
  } catch { /* 相対 URL・壊れた URL は外す */ }
  return null;
}

/** 本文の画像に使ってよいか（https、または isImageSrcAllowed が許した "/" から始まる path）。 */
export function studioRichTextImageSrc(value: string | null, options: StudioRichTextSanitizeOptions = {}): string | null {
  if (value === null) return null;
  const src = value.trim();
  if (!src || src.length > 2048 || UNSAFE_CHARS.test(src)) return null;
  if (src.startsWith("/") && !src.startsWith("//")) return options.isImageSrcAllowed?.(src) === true ? src : null;
  return httpsUrl(src);
}

function httpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? value : null;
  } catch { return null; }
}
/** 見た目の指定だけを残す（外の読み込み・式・エスケープを含むものは落とす）。空の style="" はそのまま残す。 */
function safeStyle(value: string): string | null {
  if (value.length > 1000) return null;
  return /[<>\\]|url\s*\(|image-set\s*\(|expression\s*\(|javascript\s*:|@import|behavior\s*:|-moz-binding/iu.test(value) ? null : value;
}
const size = (value: string, percent = false) => (percent ? /^(?:\d{1,5}%?)?$/u : /^(?:\d{1,5})?$/u).test(value.trim()) ? value.trim() : null;
const digits = (value: string) => /^\d{1,6}$/u.test(value.trim()) ? value.trim() : null;
/** 許した語だけを残す。全部が許せるなら元の書き方のまま。 */
function tokens(value: string, allowed: ReadonlySet<string>, separator: RegExp, join: string): string {
  const parts = value.split(separator).map((part) => part.trim()).filter(Boolean);
  const kept = parts.filter((part) => allowed.has(part.toLowerCase()));
  return kept.length === parts.length ? value : kept.join(join);
}
function allowList(value: string): string {
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  const kept = parts.filter((part) => IFRAME_ALLOW.has(part.split(/\s+/u)[0]!.toLowerCase()));
  return kept.length === parts.length ? value : kept.join("; ");
}

/** 属性 1 つを、この要素で残してよい値に直す。残さないなら null。 */
type AttributeRule = (name: string, value: string, embed: boolean) => string | null;

function anchorAttribute(name: string, value: string): string | null {
  if (name === "href") return studioRichTextHref(value);
  if (name === "target") return TARGET.has(value.trim().toLowerCase()) ? value : null;
  if (name === "rel") return tokens(value, REL, /\s+/u, " ");
  return null;
}
function iframeAttribute(name: string, value: string): string | null {
  switch (name) {
    case "src": return UNSAFE_CHARS.test(value.trim()) || value.length > 2048 ? null : httpsUrl(value.trim());
    case "width": case "height": return size(value, true);
    case "frameborder": return digits(value);
    case "title": return value.slice(0, 500);
    case "loading": return /^(lazy|eager)$/iu.test(value) ? value : null;
    case "scrolling": return /^(yes|no|auto)$/iu.test(value) ? value : null;
    case "referrerpolicy": return REFERRER.has(value.trim().toLowerCase()) ? value : null;
    case "allowfullscreen": return "";
    case "allow": return allowList(value);
    case "sandbox": return tokens(value, SANDBOX, /\s+/u, " ");
    default: return null;
  }
}
function embedCommon(name: string, value: string): string | null {
  if (name === "style") return safeStyle(value);
  if (name === "class") return /^[\w\s-]{0,500}$/u.test(value) ? value : null;
  if (/^data-[a-z0-9_.-]{1,64}$/u.test(name)) return value.length <= 2000 && !/^\s*(?:javascript|vbscript|data)\s*:/iu.test(value) ? value : null;
  if (EMBED_COMMON.has(name)) return value.slice(0, 500);
  return null;
}

/**
 * 本文の HTML を、Studio の本文で残してよい要素・属性だけにする。ブラウザ（または jsdom）の DOMParser を使う。
 * 属性は元の並びのまま写すので、STUDIO の本文の形（`<figure style="">`・`<h2 id="index_…">` など）はそのまま出る。
 */
export function sanitizeStudioRichTextHtml(html: string, options: StudioRichTextSanitizeOptions = {}): string {
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Parser) throw new Error("sanitizeStudioRichTextHtml needs DOMParser");
  if (typeof html !== "string" || !html) return "";
  const doc = new Parser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html");
  const out = doc.createElement("div");

  const copy = (from: Element, to: Element, rule: AttributeRule, embed: boolean) => {
    for (const attribute of Array.from(from.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) continue;
      const value = rule(name, attribute.value, embed);
      if (value !== null) to.setAttribute(name, value);
    }
  };
  const children = (from: Node, to: Node, embed: boolean) => { for (const child of Array.from(from.childNodes)) clean(child, to, embed); };
  const image = (element: Element, parent: Node, embed: boolean) => {
    if (studioRichTextImageSrc(element.getAttribute("src"), options) === null) return;
    const img = doc.createElement("img");
    copy(element, img, (name, value) => {
      if (name === "src") return studioRichTextImageSrc(value, options);
      if (name === "alt") return value.slice(0, 500);
      if (name === "width" || name === "height") return size(value);
      if (embed && name === "loading") return /^(lazy|eager)$/iu.test(value) ? value : null;
      return embed ? embedCommon(name, value) : null;
    }, embed);
    parent.appendChild(img);
  };
  const iframe = (element: Element, parent: Node, embed: boolean) => {
    if (iframeAttribute("src", element.getAttribute("src") ?? "") === null) return;
    const frame = doc.createElement("iframe");
    copy(element, frame, (name, value) => iframeAttribute(name, value) ?? (embed ? embedCommon(name, value) : name === "style" ? safeStyle(value) : null), embed);
    parent.appendChild(frame);
  };

  const clean = (node: Node, parent: Node, embed: boolean): void => {
    if (node.nodeType === 3) { parent.appendChild(doc.createTextNode(node.textContent ?? "")); return; }
    if (node.nodeType !== 1) return;
    const element = node as Element, raw = element.localName.toLowerCase();
    if (element.namespaceURI !== HTML_NS || DROP.has(raw)) return;
    if (raw === "iframe") { iframe(element, parent, embed); return; }
    if (raw === "img") { image(element, parent, embed); return; }
    if (embed) {
      if (!EMBED_KEEP.has(raw)) { children(element, parent, true); return; }
      if (raw === "a" && studioRichTextHref(element.getAttribute("href")) === null) { children(element, parent, true); return; }
      const next = doc.createElement(raw);
      copy(element, next, (name, value) => {
        if (raw === "a") { const kept = anchorAttribute(name, value); if (kept !== null || name === "href") return kept; }
        if (raw === "blockquote" && name === "cite") return httpsUrl(value.trim());
        if (raw === "time" && name === "datetime") return value.slice(0, 100);
        return embedCommon(name, value);
      }, true);
      if (raw !== "br" && raw !== "hr") children(element, next, true);
      parent.appendChild(next);
      return;
    }
    if (raw === "div") {
      if (element.getAttribute("data-type") === "embed_code") {
        const box = doc.createElement("div");
        copy(element, box, (name, value) => {
          if (name === "data-type") return value;
          if (name === "data-embed-code-type") return /^[\w-]{1,40}$/u.test(value) ? value : null;
          if (name === "data-embed-sandbox") return /^(true|false)$/u.test(value) ? value : null;
          return null;
        }, false);
        children(element, box, true);
        parent.appendChild(box);
        return;
      }
      // 目次の置き場は属性も中身も無い <div></div>。属性だけある空の div は残さない。
      if (element.childNodes.length === 0) { if (element.attributes.length === 0) parent.appendChild(doc.createElement("div")); return; }
      if (Array.from(element.children).some((child) => BLOCK.has(child.localName.toLowerCase()))) { children(element, parent, false); return; }
      const paragraph = doc.createElement("p");
      children(element, paragraph, false);
      parent.appendChild(paragraph);
      return;
    }
    const tag = RENAME[raw] ?? raw;
    if (tag === "a") {
      if (studioRichTextHref(element.getAttribute("href")) === null) { children(element, parent, false); return; }
      const link = doc.createElement("a");
      copy(element, link, anchorAttribute, false);
      children(element, link, false);
      parent.appendChild(link);
      return;
    }
    let rule: AttributeRule | null = null;
    if (HEADINGS.has(tag)) rule = (name, value) => name === "id" && HEADING_ID.test(value) ? value : null;
    else if (tag === "figure") rule = (name, value) => name === "style" ? safeStyle(value) : null;
    else if (tag === "ol") rule = (name, value) => name === "start" ? digits(value) : name === "type" && /^[1aAiI]$/u.test(value) ? value : null;
    else if (TABLE.has(tag)) rule = (name, value) => (name === "colspan" || name === "rowspan" || name === "span") ? digits(value) : name === "scope" && /^(row|col|rowgroup|colgroup)$/u.test(value) ? value : null;
    else if (PLAIN.has(tag)) rule = () => null;
    if (rule === null) { children(element, parent, false); return; }
    const next = doc.createElement(tag);
    copy(element, next, rule, false);
    if (tag !== "br" && tag !== "hr" && tag !== "col") children(element, next, false);
    parent.appendChild(next);
  };

  children(doc.body, out, false);
  return out.innerHTML;
}

/** 無害化しても DOM として同じになる（＝そのまま渡してよい）か。 */
export function isStudioRichTextSafe(html: string, options: StudioRichTextSanitizeOptions = {}): boolean {
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Parser || !html) return true;
  const parse = (value: string) => new Parser().parseFromString(`<!doctype html><html><head></head><body>${value}</body></html>`, "text/html").body;
  return parse(html).isEqualNode(parse(sanitizeStudioRichTextHtml(html, options)));
}
