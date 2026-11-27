import { validatePagePath } from "./pages.js";

export type ManagedSiteRedirect = {
  readonly locale: string;
  readonly fromPath: string;
  readonly toPath: string;
};

export const MAX_MANAGED_SITE_REDIRECTS = 500;

const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const REDIRECT_KEYS = ["fromPath", "locale", "toPath"] as const;

/** Parse an entire versioned redirect snapshot, rejecting ambiguous paths and loops. */
export function parseManagedSiteRedirects(value: unknown): ManagedSiteRedirect[] | null {
  if (!Array.isArray(value) || value.length > MAX_MANAGED_SITE_REDIRECTS) return null;
  const redirects: ManagedSiteRedirect[] = [];
  const bySource = new Map<string, string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== REDIRECT_KEYS.length || keys.some((key, index) => key !== REDIRECT_KEYS[index])) return null;
    const { locale, fromPath, toPath } = record;
    if (typeof locale !== "string" || locale.length > 40 || !LOCALE.test(locale)
      || validatePagePath(fromPath) !== null || validatePagePath(toPath) !== null || fromPath === toPath
      || bySource.has(fromPath as string)) return null;
    bySource.set(fromPath as string, toPath as string);
    redirects.push({ locale, fromPath: fromPath as string, toPath: toPath as string });
  }
  for (const { fromPath } of redirects) {
    const seen = new Set<string>();
    let path: string | undefined = fromPath;
    while (path !== undefined) {
      if (seen.has(path)) return null;
      seen.add(path);
      path = bySource.get(path);
    }
  }
  return redirects;
}
