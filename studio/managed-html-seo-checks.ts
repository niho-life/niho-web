/** Non-blocking SEO checks for already-rendered managed-site HTML. */
export type ManagedHtmlSeoWarning = {
  readonly code: "missing-alt" | "japanese-in-english" | "broken-internal-link";
  readonly message: string;
};

export type ManagedHtmlSeoCheckOptions = {
  /** Locale of the rendered page, for example `en` or `ja`. */
  readonly locale: string;
  /** Absolute URL of the rendered page. Relative links resolve against this URL. */
  readonly pageUrl: string;
  /** Published route paths on the same site, including any site prefix. */
  readonly knownPaths: readonly string[];
};

const MAX_HTML_LENGTH = 2_000_000;
const MAX_KNOWN_PATHS = 10_000;
const MAX_WARNINGS = 100;
const JAPANESE_TEXT = /[ぁ-ゖァ-ヺ一-龯]/u;

function boundedWarnings(warnings: readonly ManagedHtmlSeoWarning[]): ManagedHtmlSeoWarning[] {
  return warnings.slice(0, MAX_WARNINGS).map((warning) => ({
    ...warning,
    message: warning.message.length <= 1000 ? warning.message : `${warning.message.slice(0, 999)}…`
  }));
}

function routeIdentity(value: string): string | null {
  try {
    const pathname = new URL(value, "https://niho.invalid").pathname;
    return pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  } catch {
    return null;
  }
}

function decodeTextEntities(value: string): string {
  return value.replace(/&(#(?:x[\da-f]{1,6}|\d{1,7})|amp|lt|gt|quot|apos|nbsp);/giu, (entity, body: string) => {
    if (body[0] !== "#") {
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[body.toLowerCase()] ?? entity;
    }
    const hex = body[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint) : entity;
  });
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < source.length) {
    while (/[\s/]/u.test(source[index] ?? "")) index += 1;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/u.test(source[index]!)) index += 1;
    if (nameStart === index) {
      index += 1;
      continue;
    }
    const name = source.slice(nameStart, index).toLowerCase();
    while (/\s/u.test(source[index] ?? "")) index += 1;
    let value = "";
    if (source[index] === "=") {
      index += 1;
      while (/\s/u.test(source[index] ?? "")) index += 1;
      const quote = source[index] === '"' || source[index] === "'" ? source[index++] : null;
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        while (index < source.length && !/[\s>]/u.test(source[index]!)) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    if (!attributes.has(name)) attributes.set(name, decodeTextEntities(value));
  }
  return attributes;
}

function tagEnd(source: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

/**
 * Inspect rendered HTML without network or storage access. This helper is intentionally
 * separate from publishing so the host can decide when to surface its warnings.
 */
export function inspectManagedHtmlSeo(
  html: string,
  options: ManagedHtmlSeoCheckOptions
): ManagedHtmlSeoWarning[] {
  if (typeof html !== "string" || html.length > MAX_HTML_LENGTH || typeof options.locale !== "string"
    || options.locale.length > 64 || typeof options.pageUrl !== "string" || options.pageUrl.length > 2048
    || !Array.isArray(options.knownPaths) || options.knownPaths.length > MAX_KNOWN_PATHS
    || options.knownPaths.some((path) => typeof path !== "string" || path.length > 2048)) {
    throw new Error("invalid managed HTML SEO inspection input");
  }

  let page: URL;
  try {
    page = new URL(options.pageUrl);
  } catch {
    throw new Error("invalid managed HTML SEO page URL");
  }
  if (!(["http:", "https:"].includes(page.protocol))) throw new Error("invalid managed HTML SEO page URL");

  const knownPaths = new Set(options.knownPaths.map(routeIdentity).filter((path): path is string => path !== null));
  const warnings: ManagedHtmlSeoWarning[] = [];
  const addWarning = (warning: ManagedHtmlSeoWarning) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(warning);
  };
  const textParts: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) {
      textParts.push(html.slice(index));
      break;
    }
    if (open > index) textParts.push(html.slice(index, open));
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      index = close < 0 ? html.length : close + 3;
      continue;
    }
    const end = tagEnd(html, open + 1);
    if (end < 0) {
      textParts.push(html.slice(open));
      break;
    }
    const rawTag = html.slice(open + 1, end);
    const tagMatch = /^\s*(\/)?\s*([A-Za-z][A-Za-z0-9:-]*)/u.exec(rawTag);
    index = end + 1;
    if (!tagMatch || tagMatch[1]) continue;
    const tag = tagMatch[2]!.toLowerCase();
    const attributes = parseAttributes(rawTag.slice(tagMatch[0].length));
    if (tag === "img" && !(attributes.get("alt")?.trim())) {
      addWarning({ code: "missing-alt", message: "画像に代替テキストがありません。" });
    } else if (tag === "a") {
      const href = attributes.get("href")?.trim();
      if (href && !href.startsWith("#")) {
        try {
          const target = new URL(href, page);
          if (["http:", "https:"].includes(target.protocol) && target.origin === page.origin) {
            const path = routeIdentity(target.pathname);
            if (path && !knownPaths.has(path)) addWarning({
              code: "broken-internal-link",
              message: `公開中のページが見つかりません: ${path}`
            });
          }
        } catch { /* Invalid URLs are left to document validation. */ }
      }
    }
    if (tag === "script" || tag === "style") {
      const closePattern = new RegExp(`<\\/\\s*${tag}\\s*>`, "igu");
      closePattern.lastIndex = index;
      const close = closePattern.exec(html);
      if (close) index = close.index + close[0].length;
    }
  }

  if (options.locale.toLowerCase().startsWith("en") && JAPANESE_TEXT.test(decodeTextEntities(textParts.join(" ")))) {
    addWarning({ code: "japanese-in-english", message: "英語ページの本文に日本語が残っています。" });
  }
  return boundedWarnings(warnings);
}
