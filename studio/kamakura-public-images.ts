import { KAMAKURA_MEDIA_ORIGIN } from "./kamakura-cms-contract.js";

const MAX_IMAGE_WIDTH = 4096;
const RESPONSIVE_IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const;
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

/** iPhone を含むブラウザーが Client Hints なしでも選べる幅別画像候補。 */
export function kamakuraResponsiveImageSrcSet(source: string): string | null {
  const url = kamakuraMediaImage(source);
  if (!url) return null;
  return RESPONSIVE_IMAGE_WIDTHS.map((width) => `${transformedUrl(url, width)} ${width}w`).join(", ");
}

const STUDIO_IMAGE_PATH = /^\/_niho\/assets\/img_[a-z0-9]{24}\.(?:avif|jpg|png|webp)$/u;

/** Studio 画像（共通 origin の /_niho/assets/）の幅別候補。gif は動きを保つため対象外。 */
export function studioImageSrcSet(source: string, origin: string): string | null {
  if (source.length > 8192) return null;
  let url: URL;
  try { url = new URL(source); } catch { return null; }
  if (url.origin !== origin || url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !STUDIO_IMAGE_PATH.test(url.pathname)) return null;
  return RESPONSIVE_IMAGE_WIDTHS.map((width) => `${origin}/cdn-cgi/image/width=${width},format=auto${url.pathname} ${width}w`).join(", ");
}
