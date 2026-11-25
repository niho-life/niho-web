import { isSafePublicUrl } from "./validation-utils.js";

export type EditingPagePreviewIntent = { readonly url: string; readonly expiresAt: string };

export const PAGE_PREVIEW_INTENT_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow"
});

const MAX_PREVIEW_TTL_MS = 15 * 60 * 1000;

/** The URL identifies the private route. Opening it still requires host authentication. */
export function parsePagePreviewIntent(value: unknown, origin: string, now = Date.now()): EditingPagePreviewIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 2 || !Object.hasOwn(source, "url") || !Object.hasOwn(source, "expiresAt")) return null;
  if (!isSafePublicUrl(source.url) || /[?#]/u.test(source.url) || typeof source.expiresAt !== "string" || source.expiresAt.length !== 24) return null;
  const expiry = Date.parse(source.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + MAX_PREVIEW_TTL_MS || new Date(expiry).toISOString() !== source.expiresAt) return null;
  const url = new URL(source.url, origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return null;
  return { url: url.href, expiresAt: source.expiresAt };
}
