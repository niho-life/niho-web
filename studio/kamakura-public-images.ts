import { KAMAKURA_MEDIA_ORIGIN } from "./kamakura-cms-contract.js";

const MAX_IMAGE_WIDTH = 4096;
const TRANSFORMABLE_IMAGE_PATH = /\.(?:avif|jpe?g|png|webp)$/iu;

function kamakuraMediaImage(value: string): URL | null {
  if (value.length > 8192 || /[\u0000-\u001f\u007f\\]/u.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== KAMAKURA_MEDIA_ORIGIN || url.protocol !== "https:" || url.username || url.password
    || url.search || url.hash || url.pathname.startsWith("/cdn-cgi/") || !TRANSFORMABLE_IMAGE_PATH.test(url.pathname)) return null;
  return url;
}

function transformedUrl(url: URL, width: number): string {
  return `${KAMAKURA_MEDIA_ORIGIN}/cdn-cgi/image/width=${width},format=auto${url.pathname}`;
}

/** 既存の公開画像 origin にある画像だけを、format negotiation 付きの指定幅へ縮小する。 */
export function kamakuraImageUrl(source: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return source;
  const url = kamakuraMediaImage(source);
  if (!url) return source;
  return transformedUrl(url, Math.min(MAX_IMAGE_WIDTH, Math.max(16, Math.round(width))));
}

/** 公開 HTML の img 用。Cloudflare が client hints または User-Agent から表示幅に合う画像を選ぶ。 */
export function kamakuraResponsiveImageUrl(source: string): string | null {
  const url = kamakuraMediaImage(source);
  if (!url) return null;
  return `${KAMAKURA_MEDIA_ORIGIN}/cdn-cgi/image/width=auto,format=auto${url.pathname}`;
}
